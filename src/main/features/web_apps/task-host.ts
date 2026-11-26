/** App-owned adapters to the existing Agent task facade. No second runner. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { webAppSandboxRoot, appConversationOwner, appConversationRoot, appLocalConversationRoot, userCloudRoot, userLocalRoot } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';
import { MAX_TEXT_FILE_BYTES } from '../../util/file-size-limits';
import { writeBytesAtomic } from '../../storage';
import { appTaskInteractions, takeAppTaskInteraction, clearAppTaskEvents } from '../../util/app-task-events';
import { createLogger } from '../../logger';
import { AppError } from './runtime';
import { AppTaskService, TaskInputError, type SettledInspection, type TaskInspection } from './tasks';
import { getActiveUserId } from '../users';
import { pendingTask, drainPendingTasks, appTaskHostId } from './task-maintenance';
import * as deleteConfirmation from '../../model/core-agent/delete-file-confirm';
import { t } from '../../i18n';
import { resolveLanguageForUser } from '../config';
const log = createLogger('app-tasks');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function guard(file: string, root: string) {
    if (!isPathAllowed(file, [root])) throw new AppError('E_FILE');
    for (let p = file; ; p = path.dirname(p)) {
        try { const st = await fs.lstat(p); if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1)) throw new AppError('E_FILE'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (p === root) break;
        if (path.dirname(p) === p) throw new AppError('E_FILE');
    }
}
async function regularFile(file: string, root: string, expected?: TaskFile) {
    await guard(file, root);
    const before = await fs.lstat(file);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
        const st = await handle.stat();
        if (!st.isFile() || st.nlink !== 1 || st.size > MAX_TEXT_FILE_BYTES || st.ino !== before.ino || st.dev !== before.dev) throw new AppError('E_FILE');
        if (expected && (st.size !== expected.bytes || Math.floor(st.mtimeMs) !== Math.floor(expected.mtime))) throw new AppError('E_FILE');
        const chunks: Buffer[] = []; let count = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
            count += chunk.length;
            if (count > MAX_TEXT_FILE_BYTES) throw new AppError('E_LIMIT');
            chunks.push(chunk);
        }
        const after = await fs.lstat(file);
        if (after.ino !== st.ino || after.dev !== st.dev || after.mtimeMs !== st.mtimeMs || after.size !== count) throw new AppError('E_FILE');
        await guard(file, root);
        return Buffer.concat(chunks, count);
    } finally { await handle.close(); }
}
async function ownedRoot(uid: string, cid: string) {
    const root = appConversationRoot(uid, cid);
    if (root) { await guard(root, appConversationOwner(cid)!.keepSession ? userCloudRoot(uid) : userLocalRoot(uid)); return root; }
    // Only receipt-authorized legacy tasks reach this adapter. Early v1 hosts
    // created normal conversations; their source data must remain untouched.
    const conv = await (await import('../chats')).getConversationMetadata(uid, cid);
    if (!conv || !['normal', 'app_task'].includes(conv.kind)) throw new AppError('E_TASK');
    return null;
}
/** A receipt carries at most this many files. */
const MAX_RECEIPT_FILES = 100;
/** Limit the general artifact scan. Declared deliveries have a separate receipt-sized lookup. */
const MAX_ARTIFACT_FILES = 1000;
const MAX_ARTIFACT_DEPTH = 8;
type TaskFile = { path: string; name: string; bytes: number; mtime: number; relative: string };
type OutputRoots = { workspace: string; appRoot: string | null };
type SelectedFile = TaskFile & { published?: boolean };
// Only archive consumes this selection. Absolute paths never enter the SDK response or durable receipt.
const outputSelections = new WeakMap<TaskInspection, { files: SelectedFile[]; workspace: string; unavailableDelivery: boolean }>();

function unavailableSource(error: unknown): boolean {
    if (error instanceof AppError) return ['E_FILE', 'E_LIMIT'].includes(error.code);
    return ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}
function relativeInside(root: string, file: string): string | undefined {
    const relative = path.relative(root, file);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return relative;
}
function declaredOutputRelative(file: string, roots: OutputRoots): string | undefined {
    const workspace = relativeInside(roots.workspace, file);
    if (workspace) return workspace.split(path.sep).join('/');
    if (!roots.appRoot || path.basename(file) === '__orkas-meta.json') return;
    const artifact = relativeInside(path.join(roots.appRoot, 'artifacts'), file)?.split(path.sep);
    if (artifact && artifact.length <= MAX_ARTIFACT_DEPTH + 1) return 'artifacts/' + artifact.join('/');
}
async function declaredOutput(file: string, relative: string, roots: OutputRoots): Promise<TaskFile> {
    await guard(file, roots.appRoot || roots.workspace);
    const st = await fs.lstat(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_TEXT_FILE_BYTES) throw new AppError('E_FILE');
    return { path: file, relative, name: path.basename(file), bytes: st.size, mtime: st.mtimeMs };
}
/** General inventory for filling a receipt and resolving live outputs. */
async function allOutputs(uid: string, cid: string): Promise<OutputRoots & { files: TaskFile[] }> {
    const { listConversationOutputs } = await import('../conversation_outputs');
    const result = await listConversationOutputs(uid, cid);
    const files: TaskFile[] = result.items.filter(item => item.path && item.origin === 'workspace').map(v => ({ path: v.path!, name: v.name, bytes: v.bytes, mtime: v.mtime, relative: v.relPath }));
    const appRoot = appConversationRoot(uid, cid);
    if (appRoot) {
        const artifactRoot = path.join(appRoot, 'artifacts');
        let artifacts = 0;
        const walk = async (dir: string, depth: number) => {
            if (depth > MAX_ARTIFACT_DEPTH) throw new AppError('E_LIMIT');
            for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
                if (artifacts >= MAX_ARTIFACT_FILES) return;
                if (entry.name === '__orkas-meta.json') continue;
                const file = path.join(dir, entry.name);
                await guard(file, appRoot);
                if (entry.isDirectory()) await walk(file, depth + 1);
                else {
                    if (!entry.isFile()) throw new AppError('E_LIMIT');
                    const st = await fs.lstat(file);
                    artifacts++;
                    files.push({ path: file, name: entry.name, bytes: st.size, mtime: st.mtimeMs, relative: 'artifacts/' + path.relative(artifactRoot, file).split(path.sep).join('/') });
                }
            }
        };
        await walk(artifactRoot, 0);
    }
    return { files, workspace: result.root, appRoot };
}
/** The files a receipt carries. A run that leaves more, such as VideoStudio
 *  frames and test renders, keeps the files its reply delivered, then the
 *  newest others. On 2026-11-17 one such run failed every result read with
 *  E_LIMIT, so the user never saw its reply that the footage had not arrived. */
function receiptFiles(files: TaskFile[], delivered: readonly string[] | undefined): TaskFile[] {
    const wanted = new Set((delivered || []).map(file => path.resolve(file)));
    const isDelivered = (file: TaskFile) => wanted.has(path.resolve(file.path));
    // An unpublished intermediate that cannot be read by the output API must
    // not prevent archival of the reply and its explicitly delivered files.
    const candidates = files.filter(file => file.bytes <= MAX_TEXT_FILE_BYTES || isDelivered(file));
    if (candidates.length <= MAX_RECEIPT_FILES) return candidates;
    const others = candidates.filter(file => !isDelivered(file)).sort((a, b) => b.mtime - a.mtime);
    return [...candidates.filter(isDelivered), ...others].slice(0, MAX_RECEIPT_FILES);
}
async function selectOutputs(uid: string, cid: string, delivered: readonly string[] | undefined) {
    const inventory = await allOutputs(uid, cid);
    const scanned = new Set(inventory.files.map(file => file.path));
    let unavailableDelivery = false;
    // Resolve exact declarations that the general scans could not see.
    const declarations = new Set(delivered?.slice(0, MAX_RECEIPT_FILES).filter(file => path.isAbsolute(file)).map(file => path.resolve(file)));
    for (const file of declarations) {
        if (scanned.has(file)) continue;
        const relative = declaredOutputRelative(file, inventory);
        if (!relative) continue;
        try { inventory.files.push(await declaredOutput(file, relative, inventory)); }
        catch (error) {
            if (!unavailableSource(error)) throw error;
            unavailableDelivery = true;
        }
    }
    const { markPublishedOutputs } = await import('./task-output');
    return { workspace: inventory.workspace, unavailableDelivery, files: markPublishedOutputs(receiptFiles(inventory.files, delivered), delivered) };
}
async function pendingMedia(uid: string, cid: string): Promise<boolean> {
    const root = appConversationRoot(uid, cid);
    if (!root) return false;
    for (const kind of ['generation']) {
        const dir = path.join(root, kind);
        const entries = await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
        if (entries.length > 100) throw new AppError('E_LIMIT');
        for (const name of entries) {
            if (!/^[a-f0-9]{32,64}\.json$/.test(name)) throw new AppError('E_FILE');
            const file = path.join(dir, name);
            await guard(file, root);
            if ((await fs.stat(file)).size > 1048576) throw new AppError('E_LIMIT');
            const v = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!Array.isArray(v.transactions) || v.transactions.some(t => t.status === 'pending')) return true;
        }
    }
    return false;
}
async function inspect(uid: string, cid: string, messageId?: string, baseline?: string[], cancelRequested = false): Promise<TaskInspection> {
    await ownedRoot(uid, cid);
    if (!await (await import('../chats')).getConversationMetadata(uid, cid)) throw new AppError('E_TASK');
    const chat = await import('../group_chat');
    const [board, messages, runtime] = await Promise.all([chat.listTasks(uid, cid), chat.readMessages(uid, cid, 30, { strict: true }), chat.runtimeStatus(uid, cid)]);
    if (!board.ok) throw new AppError('E_TASK');
    const all = board.tasks.filter(row => !row.absorbed_into_task_id);
    const excluded = baseline ? new Set(baseline) : null;
    const rows = excluded ? all.filter(row => !excluded.has(row.task_id)) : messageId ? all.filter(row => row.source_msg_id === messageId) : all;
    const pending = rows.find(row => row.status === 'waiting_input' || row.status === 'blocked');
    const interactions = appTaskInteractions(uid, cid);
    const core = await import('#core-agent');
    const children = core.runningCommandSessions(`${uid}:${cid}`) + core.runningProcessSessions(`${uid}:${cid}`);
    const externalPending = await pendingMedia(uid, cid);
    const backgroundMedia = (await import('../local_agents/runner')).hasConversationBackgroundMedia(uid, cid);
    const direct = appConversationOwner(cid)?.keepSession === false;
    let status = interactions.length ? 'waiting_input' : runtime.processing || children || externalPending || backgroundMedia ? 'running' : pending ? 'waiting_input'
        : rows.some(row => row.status === 'failed') ? 'failed' : rows.some(row => row.status === 'stopped' || row.status === 'cancelled') ? 'stopped'
        : rows.length && rows.every(row => row.status === 'done') ? 'completed' : 'unknown';
    const results = new Set(rows.map(row => row.result_msg_id).filter(Boolean));
    const reply = [...messages].reverse().find(msg => results.has(msg.id));
    const form = [...messages].reverse().find(msg => results.has(msg.id) && msg.form && !msg.form.submitted);
    if (form) status = 'waiting_input';
    // An unanswered question must not dispose of a paid request or a live child.
    // Its real owner settles first; no synthetic reply or generation replay occurs.
    if (direct && (externalPending || backgroundMedia) && status === 'waiting_input') status = 'running';
    // Stopped waiting turns remain on the shared board. A durable app cancel
    // settles them only after every execution/media owner has become idle.
    if (cancelRequested && !runtime.processing && !children && !externalPending && !backgroundMedia
        && ['waiting_input', 'unknown'].includes(status)) status = 'stopped';
    if (['completed', 'failed', 'stopped'].includes(status)) {
        if (!await (await import('../group_chat/bus')).drainConversationWrites(uid, cid)) status = 'running';
    }
    const selection = ['running', 'unknown'].includes(status) ? undefined : await selectOutputs(uid, cid, reply?.produced);
    const result: TaskInspection = { status, text: reply?.text?.slice(0, 40000) || '',
        files: (selection?.files ?? []).map(file => ({ id: hash(file.path), name: file.name, bytes: file.bytes, ...(file.published !== undefined ? { published: file.published } : {}), version: hash(JSON.stringify([file.bytes, file.mtime])) })),
        ...(status === 'waiting_input' && reply ? { inputId: reply.id } : {}),
        ...(interactions.length ? { interactions } : {}), ...(form ? { form: { messageId: form.id, ...form.form } } : {}) };
    if (selection) outputSelections.set(result, selection);
    return result;
}
export const taskService = new AppTaskService({
    activeUser: getActiveUserId,
    hostId: appTaskHostId,
    reserve: (scope, input) => `app_${scope.key}_${input.keepSession ? 'retain' : 'once'}_${randomUUID().replace(/-/g, '')}`,
    checkpoint: async (uid, cid) => {
        const board = await (await import('../group_chat')).listTasks(uid, cid);
        if (!board.ok || board.tasks.length > 1000) throw new AppError('E_LIMIT');
        return board.tasks.map(v => v.task_id);
    },
    assertOwner: async (uid, cid, scope, archived, legacyReceipt) => {
        const owner = appConversationOwner(cid);
        if (owner) { if (owner.key !== scope.key) throw new AppError('E_TASK'); return; }
        if (archived) return;
        const conv = await (await import('../chats')).getConversationMetadata(uid, cid);
        if (conv?.kind !== 'app_task' && !(legacyReceipt && conv?.kind === 'normal')) throw new AppError('E_TASK');
    },
    create: async (uid, title, scope, input, reservedCid) => {
        if (!scope || !reservedCid) throw new AppError('E_INPUT');
        await ownedRoot(uid, reservedCid);
        const conv = await (await import('../chats')).createAppConversation(uid, scope.key, title, input?.keepSession === true, reservedCid);
        return { conversation_id: conv.conversation_id, ...(input?.keepSession ? { sessionId: appConversationOwner(conv.conversation_id)!.token } : {}) };
    },
    send: async (uid, cid, input, scope) => {
        await ownedRoot(uid, cid);
        const attachments: string[] = [];
        const chat = await import('../group_chat');
        try {
            const { getAgent } = await import('../agents');
            if (input.agentId !== 'commander') {
                const agent = await getAgent(input.agentId);
                if (!agent || !agent.enabled) throw new AppError('E_UNAVAILABLE');
                await (await import('../group_chat/state')).ensureAgentMember(uid, cid, input.agentId, agent.name);
            }
            if(input.media)await(await import('./media-services')).resolveAppMediaService(uid,input.media);
            const mediaRoutes=await import('../app_media_route');
            try{await mediaRoutes.saveAppMediaRoute(uid,cid,input.media);}catch(error){if(error instanceof mediaRoutes.AppMediaRouteError)throw new AppError(error.code);throw error;}
            const root = path.join(webAppSandboxRoot(uid, scope.key, 'cloud'), 'files');
            for (const relative of input.files) {
                if (getActiveUserId() !== uid) throw new AppError('E_CLOSED');
                const bytes = await regularFile(path.join(root, ...relative.split('/')), userCloudRoot(uid));
                const saved = await (await import('../chat_attachments')).uploadAttachment(uid, cid, path.basename(relative), bytes);
                if (!saved.ok) throw new AppError('E_FILE');
                attachments.push(saved.info.name);
            }
            if (getActiveUserId() !== uid) throw new AppError('E_CLOSED');
            if (!(await chat.setFloor(uid, cid, input.agentId)).ok) throw new AppError('E_UNAVAILABLE');
        } catch (cause) { throw new TaskInputError(cause instanceof AppError ? cause.code : 'E_FILE'); }
        return chat.send({ userId: uid, cid, text: input.prompt, title_text: input.title, forceTo: [input.agentId], attachments });
    },
    inspect,
    cancel: async (uid, cid) => {
        const chat = await import('../group_chat');
        await chat.abort(uid, cid);
        const board = await chat.listTasks(uid, cid);
        if (!board.ok) throw new AppError('E_TASK');
        // Shared Stop leaves already-waiting rows intact. Close their existing
        // board/floor owner so a later retained-session turn can be admitted.
        for (const row of board.tasks) {
            if (row.absorbed_into_task_id || !['waiting_input', 'blocked'].includes(row.status)) continue;
            const cancelled = await chat.cancelTask(uid, cid, row.task_id);
            if (!cancelled.ok && cancelled.error !== 'not_cancellable') throw new AppError('E_TASK');
        }
    },
    rejectInteraction: async (uid, cid) => {
        if (appConversationOwner(cid)?.keepSession !== false) return false;
        if (await pendingMedia(uid, cid) || (await import('../local_agents/runner')).hasConversationBackgroundMedia(uid, cid)) return false;
        const chat = await import('../group_chat');
        await chat.abort(uid, cid);
        // Deny gates through their original owners. Never turn a missing reply into a grant.
        for (const interaction of appTaskInteractions(uid, cid)) {
            if (interaction.kind === 'bash:permission') (await import('../../model/core-agent/bash-permissions')).respond(interaction.id, 'deny');
            else if (interaction.kind === 'connectors:action-confirm') (await import('../connectors/action_confirm')).respond(interaction.id, false, 'once');
            else if (interaction.kind === 'local-agent:permission') await (await import('../local_agents/cli_permissions')).respond(interaction.id, 'deny');
            else if (interaction.kind === 'local-agent:user-input') await (await import('../local_agents/cli_user_input')).respond(interaction.id, uid, undefined, true);
            else if (interaction.kind === 'delete_file.confirmation_required') deleteConfirmation.resolveConfirmation(interaction.id, false);
            takeAppTaskInteraction(uid, cid, interaction.id);
        }
        const board = await chat.listTasks(uid, cid);
        if (!board.ok) throw new AppError('E_TASK');
        for (const row of board.tasks) if (!row.absorbed_into_task_id && ['waiting_input', 'blocked'].includes(row.status)) {
            const cancelled = await chat.cancelTask(uid, cid, row.task_id);
            if (!cancelled.ok && cancelled.error !== 'not_cancellable') throw new AppError('E_TASK');
        }
        return true;
    },
    archive: async (uid, cid, result, scope, requestId, deliverable, output) => {
        const owner = appConversationOwner(cid);
        if (owner && owner.key !== scope.key) throw new AppError('E_TASK');
        const root = await ownedRoot(uid, cid);
        const selection = outputSelections.get(result);
        if (!selection && result.files.length) throw new AppError('E_FILE');
        let unavailableDelivery = selection?.unavailableDelivery ?? false;
        const archived: TaskInspection['files'] = [];
        for (const file of selection?.files ?? []) {
            if (uid !== getActiveUserId()) throw new AppError('E_CLOSED');
            let bytes: Buffer;
            try { bytes = await regularFile(file.path, root || selection!.workspace, file); }
            catch (error) {
                if (!unavailableSource(error)) throw error;
                if (file.published) unavailableDelivery = true;
                continue;
            }
            const version = hash(bytes), id = hash(file.path);
            const relative = file.relative.startsWith('artifacts/') ? file.relative
                : `${id.slice(0, 16)}-${version.slice(0, 16)}${path.extname(file.name).slice(0, 16)}`;
            const appPath = `results/${hash(requestId)}/${relative}`;
            const destination = path.join(webAppSandboxRoot(uid, scope.key, 'cloud'), 'files', ...appPath.split('/'));
            await guard(destination, userCloudRoot(uid));
            await writeBytesAtomic(destination, bytes, { shouldCommit: () => getActiveUserId() === uid });
            const published = file.published;
            archived.push({ id, version, name: file.name, bytes: bytes.length, path: appPath, ...(published !== undefined ? { published } : {}) });
        }
        const error = result.error as { code?: string } | undefined;
        if (unavailableDelivery && (result.status === 'completed' || (result.status === 'failed' && (!error || error.code === 'E_OUTPUT_MISSING')))) {
            result.status = 'failed';
            result.error = { code: 'E_OUTPUT_SAVE_FAILED' };
        }
        if (result.status === 'completed' && deliverable && (deliverable !== 'text' || output?.format)) {
            const { isAppDeliverable, isAppTextDeliverable, AppOutputUnverifiedError } = await import('./task-output');
            const validation = AbortSignal.timeout(30000);
            // Aspect, format and duration are creative preferences, never completion gates.
            let found = deliverable === 'text' && isAppTextDeliverable(result.text);
            let unverified = false;
            // Preserve a valid direct JSON/SRT answer in its preferred format when
            // capacity allows; other text still uses the ordinary text fallback.
            if (found && (output?.format === 'json' || output?.format === 'srt') && isAppTextDeliverable(result.text, output.format)) {
                const bytes = Buffer.from(result.text, 'utf8'), version = hash(bytes), format = output.format;
                const existing = archived.some(file => file.version === version && path.extname(file.name).toLowerCase() === '.' + format);
                if (!existing && archived.length < 100) {
                    const id = hash('reply:' + requestId), appPath = `results/${hash(requestId)}/${id.slice(0,16)}-${version.slice(0,16)}.${format}`;
                    const destination = path.join(webAppSandboxRoot(uid, scope.key, 'cloud'), 'files', ...appPath.split('/'));
                    await guard(destination, userCloudRoot(uid));
                    if (uid !== getActiveUserId()) throw new AppError('E_CLOSED');
                    await writeBytesAtomic(destination, bytes, { shouldCommit: () => getActiveUserId() === uid });
                    archived.push({id,version,name:'reply.'+format,bytes:bytes.length,path:appPath,published:true});
                }
            }
            for (const file of archived) {
                if (found || validation.aborted) break;
                try {
                    if (await isAppDeliverable(path.join(webAppSandboxRoot(uid, scope.key, 'cloud'), 'files', ...file.path!.split('/')), deliverable, validation)) { found = true; break; }
                } catch (error) { if (!(error instanceof AppOutputUnverifiedError)) throw error; unverified = true; }
            }
            if (!found) { result.status = 'failed'; result.error = { code: validation.aborted || unverified ? 'E_OUTPUT_UNVERIFIED' : 'E_OUTPUT_MISSING' }; }
        }
        // Interaction payloads and forms are execution context, not receipts.
        return { status: result.status, text: result.text, files: archived, ...(result.error?{error:result.error}:{}) };
    },
    cleanup: async (uid, cid) => {
        if (!appConversationOwner(cid)) {
            const conv = await (await import('../chats')).getConversationMetadata(uid, cid);
            if (!conv || conv.kind === 'normal') return;
        }
        const root = await ownedRoot(uid, cid);
        const bus = await import('../group_chat/bus');
        if (!await bus.drainConversationWrites(uid, cid)) throw new AppError('E_BUSY');
        await bus.dropConv(uid, cid);
        if (root) {
            if (!(await import('../../model/core-agent/session-store')).evictAppSessions(uid, cid)) throw new AppError('E_BUSY');
            await guard(root, path.dirname(path.dirname(root)));
            await fs.rm(root, { recursive: true, force: true });
            const localRoot = appLocalConversationRoot(uid, cid)!;
            if (localRoot !== root) { await guard(localRoot, userLocalRoot(uid)); await fs.rm(localRoot, { recursive: true, force: true }); }
        } else {
            await (await import('../chats')).deleteConversation(uid, cid);
        }
        clearAppTaskEvents(uid, cid);
    },
    output: async (uid, cid, id, result, scope) => {
        if (result && scope) {
            const file = result.files.find(v => v.id === id);
            if (!file?.path || !/^results\/[a-f0-9]{64}\//.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\\'))) throw new AppError('E_FILE');
            const absolute = path.join(webAppSandboxRoot(uid, scope.key, 'cloud'), 'files', ...file.path.split('/'));
            const bytes = await regularFile(absolute, userCloudRoot(uid));
            if (hash(bytes) !== file.version) throw new AppError('E_FILE');
            return { base64: bytes.toString('base64'), name: file.name };
        }
        const root = await ownedRoot(uid, cid);
        const inventory = await allOutputs(uid, cid);
        const file = inventory.files.find(v => hash(v.path) === id);
        if (file) return { base64: (await regularFile(file.path, root || inventory.workspace)).toString('base64'), name: file.name };
        // A live receipt may have found a declared delivery beyond the general scan.
        const { listProducedPaths } = await import('../chats');
        const match = (await listProducedPaths(uid, cid, 30)).find(value => path.isAbsolute(value) && hash(path.resolve(value)) === id);
        const absolute = match && path.resolve(match);
        const relative = absolute && declaredOutputRelative(absolute, inventory);
        if (!absolute || !relative) throw new AppError('E_FILE');
        return { base64: (await regularFile(absolute, root || inventory.workspace)).toString('base64'), name: path.basename(absolute) };
    },
    respond: async (uid, cid, args, request) => {
        if (args.kind === 'text') {
            const current = await inspect(uid, cid);
            if (current.status !== 'waiting_input' || !args.inputId || current.inputId !== args.inputId
                || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 40000
                || !/^[a-zA-Z0-9_-]{1,64}$/.test(args.responseId)) throw new AppError('E_INPUT');
            const sent = await (await import('../group_chat')).send({ userId: uid, cid, text: args.text, client_msg_id: `app-reply-${args.responseId}` });
            if (!sent.ok) throw new AppError('E_TASK_UNCERTAIN');
            return { handled: true, messageId: sent.msg?.id };
        }
        if (args.kind === 'form') {
            const chat = await import('../group_chat');
            const messages = await chat.readMessages(uid, cid, 100, { strict: true });
            const target = messages.find(m => m.id === args.messageId);
            const board = await chat.listTasks(uid, cid);
            // Form history survives retained-session turns. Only a result from
            // this receipt may consume an answer; absorbed current rows still
            // own identical response retries.
            const baseline = request?.baseline ? new Set(request.baseline) : null;
            if (!board.ok || !board.tasks.some(row => (target?.task_id ? row.task_id === target.task_id : row.result_msg_id === args.messageId)
                && (baseline ? !baseline.has(row.task_id) : request?.messageId ? row.source_msg_id === request.messageId : true))) throw new AppError('E_INPUT');
            if (uid !== getActiveUserId()) throw new AppError('E_CLOSED');
            const form = target?.form;
            if (!form || form.form_id !== args.formId) throw new AppError('E_INPUT');
            const values = { ...args.values };
            const owner = appConversationOwner(cid);
            for (const field of form.fields.filter(f => f.type === 'file')) {
                if (values[field.id] === undefined) continue;
                if (!owner) throw new AppError('E_UNAVAILABLE');
                const incoming = field.multiple ? values[field.id] : [values[field.id]];
                if (!Array.isArray(incoming) || incoming.length > 20) throw new AppError('E_INPUT');
                const attached: string[] = [];
                for (const relative of incoming) {
                    if (typeof relative !== 'string' || !/^inputs\/[a-zA-Z0-9_-]+\.[a-z0-9]{1,8}$/.test(relative)) throw new AppError('E_INPUT');
                    const root = path.join(webAppSandboxRoot(uid, owner.key, 'cloud'), 'files');
                    const saved = await (await import('../chat_attachments')).uploadAttachment(uid, cid, path.basename(relative), await regularFile(path.join(root, relative), userCloudRoot(uid)));
                    if (!saved.ok) throw new AppError('E_FILE');
                    attached.push(path.join((await import('../../util/project-layout')).chatAttachmentDirForConversation(uid, cid), saved.info.name));
                }
                values[field.id] = field.multiple ? attached : attached[0];
            }
            const result = await chat.markFormSubmittedAndDispatch({ userId: uid, cid, msgId: args.messageId, formId: args.formId, values });
            if (!result.ok || !result.submission) throw new AppError('E_INPUT');
            const replyId = `app-form-${args.messageId}`;
            // client_msg_id only identifies the optimistic bubble. A persisted
            // answer proves admission even when the original RPC reply was lost.
            const previous = messages.find(m => m.from === 'user' && m.client_msg_id === replyId);
            if (previous) return { handled: true, messageId: previous.id };
            const sent = await chat.send({ userId: uid, cid, text: result.submission.text, forceTo: [result.submission.agent_id], client_msg_id: replyId });
            if (!sent.ok) throw new AppError('E_TASK_UNCERTAIN');
            return { handled: true, messageId: sent.msg?.id };
        }
        if (args.kind === 'delete_file.confirmation_required' && args.visible === true) {
            if (!appTaskInteractions(uid, cid).some(v => v.id === args.interactionId && v.kind === args.kind)) throw new AppError('E_INPUT');
            return { handled: deleteConfirmation.markConfirmationVisible(args.interactionId) };
        }
        if (args.kind !== 'local-agent:user-input' && !['allow_once', 'allow_run', 'deny'].includes(args.decision)) throw new AppError('E_INPUT');
        const interaction = takeAppTaskInteraction(uid, cid, args.interactionId);
        if (!interaction || interaction.kind !== args.kind) throw new AppError('E_INPUT');
        if (args.kind === 'delete_file.confirmation_required') {
            const granted = args.decision !== 'deny';
            if (!deleteConfirmation.resolveConfirmation(args.interactionId, granted)) return { handled: false };
            if (!granted) return { handled: true };
            const text = t('local.delete_file.user_continue', undefined, resolveLanguageForUser(uid));
            const sent = await (await import('../group_chat')).send({ userId: uid, cid, text, client_msg_id: `app-delete-${args.interactionId}` });
            return { handled: sent.ok, messageId: sent.msg?.id };
        }
        if (args.kind === 'bash:permission') return { handled: (await import('../../model/core-agent/bash-permissions')).respond(args.interactionId, args.decision) };
        if (args.kind === 'connectors:action-confirm') return { handled: (await import('../connectors/action_confirm')).respond(args.interactionId, args.decision !== 'deny', args.decision === 'allow_run' ? 'task' : 'once') };
        if (args.kind === 'local-agent:permission') return (await import('../local_agents/cli_permissions')).respond(args.interactionId, args.decision);
        if (args.kind === 'local-agent:user-input') return (await import('../local_agents/cli_user_input')).respond(args.interactionId, uid, args.values, args.decision === 'deny');
        throw new AppError('E_INPUT');
    },
    watch: async (s, requestId) => { await pendingTask(s.userId, s.key, requestId, true); startAppTaskMaintenance(); },
    unwatch: async (s, requestId) => pendingTask(s.userId, s.key, requestId, false),
});
let timer: NodeJS.Timeout | undefined, maintenance: Promise<void> | undefined, lastWarning = 0;
export async function maintainAppTasks(): Promise<void> {
    if (maintenance) return;
    const pass = drainPendingTasks(getActiveUserId(), getActiveUserId, async (s, id) => { await taskService.settle(s, id); }, code => {
        if (Date.now() - lastWarning < 60000) return;
        lastWarning = Date.now(); log.warn('app task storage pending', { code });
    });
    maintenance = pass;
    try {
        await pass;
    } finally { maintenance = undefined; }
}
export function startAppTaskMaintenance(): void {
    if (timer) return;
    timer = setInterval(() => { void maintainAppTasks().catch(() => {
        if (Date.now() - lastWarning >= 60000) { lastWarning = Date.now(); log.warn('app task recovery unavailable', { code: 'E_STORAGE' }); }
    }); }, 5000);
    timer.unref();
}
export function stopAppTaskMaintenance(): Promise<void> | undefined {
    if (timer) clearInterval(timer);
    timer = undefined;
    return maintenance;
}
export async function appTaskCall(uid: string, key: string, method: string, args: any, signal: AbortSignal) {
    if (uid !== getActiveUserId() || signal.aborted) throw new AppError('E_CLOSED');
    if (method === 'tasks.agents') {
        const list = await (await import('../agents')).listAgentSummaries();
        return { agents: [{ id: 'commander', name: 'Commander' }, ...list.filter(agent => agent.enabled).slice(0, 100).map(agent => ({ id: agent.agent_id, name: agent.name }))] };
    }
    if(method==='tasks.services')return(await import('./media-services')).listAppMediaServices(args.kind,signal,args.refresh===true);
    const scope = { userId: uid, key, signal };
    let settled: SettledInspection | undefined;
    if (method === 'tasks.get') {
        try { settled = await taskService.settle(scope, args.requestId); }
        catch (cause) {
            if (cause instanceof AppError && ['E_CLOSED', 'E_CANCELLED', 'E_TASK', 'E_INPUT'].includes(cause.code)) throw cause;
            const result = await taskService.call(scope, method, args);
            if (result.saved) return result;
            return { ...result, status: 'saving', storageError: true };
        }
    }
    return taskService.call(scope, method, args, settled);
}
