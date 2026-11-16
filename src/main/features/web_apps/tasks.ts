/** App-owned receipts and session lifecycle. The existing Agent executor owns
 * execution; this service never retries or replays a model/tool invocation. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { webAppSandboxRoot, userCloudRoot } from '../../paths';
import { writeJson, safeId } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { isPathAllowed } from '../../util/path-sandbox';
import { AppError } from './runtime';
import { validTaskOutput, type TaskOutput } from './task-output-contract';
export interface TaskScope { userId: string; key: string; signal: AbortSignal }
export interface Start {
    requestId: string; title: string; prompt: string; agentId: string; files: string[];
    keepSession?: boolean; sessionId?: string;
    media?: import('./media-services').MediaSelection;
    deliverable?: 'image' | 'video' | 'audio' | 'text';
    output?: TaskOutput;
}
export class TaskInputError extends AppError {}
interface Receipt {
    version: 1 | 2; requestId: string; fingerprint: string; cid?: string;
    phase: 'preparing' | 'dispatching' | 'submitted' | 'rejected'; createdAt: string;
    keepSession?: boolean; sessionId?: string; messageId?: string;
    baseline?: string[]; cancelRequested?: boolean;
    hostId?: string;
    result?: TaskInspection; cleaned?: boolean; errorCode?: string;
    directDelivery?: boolean; deliverable?: Start['deliverable']; output?: TaskOutput; interactionRejected?: boolean;
}
export interface TaskInspection {
    status: string; text: string;
    files: Array<{ id: string; name: string; bytes: number; version?: string; path?: string; published?: boolean }>;
    [key: string]: unknown;
}
export interface TaskDependencies {
    activeUser(): string;
    hostId?(uid: string): Promise<string>;
    reserve?(scope: TaskScope, input: Start): string;
    checkpoint?(uid: string, cid: string): Promise<string[]>;
    assertOwner?(uid: string, cid: string, scope: TaskScope, archived?: boolean, legacyReceipt?: boolean): Promise<void>;
    create(uid: string, title: string, scope?: TaskScope, input?: Start, reservedCid?: string): Promise<{ conversation_id: string; sessionId?: string }>;
    send(uid: string, cid: string, input: Start, scope: TaskScope): Promise<{ ok: boolean; msg?: { id: string } }>;
    inspect(uid: string, cid: string, messageId?: string, baseline?: string[], cancelRequested?: boolean): Promise<TaskInspection>;
    cancel(uid: string, cid: string): Promise<unknown>;
    rejectInteraction?(uid: string, cid: string): Promise<boolean>;
    open?(uid: string, cid: string): Promise<unknown>;
    output?(uid: string, cid: string, id: string, result?: TaskInspection, scope?: TaskScope): Promise<unknown>;
    archive?(uid: string, cid: string, result: TaskInspection, scope: TaskScope, requestId: string, deliverable?: Start['deliverable'], output?: TaskOutput): Promise<TaskInspection>;
    cleanup?(uid: string, cid: string): Promise<void>;
    respond?(uid: string, cid: string, args: any, request?: { messageId?: string; baseline?: string[] }): Promise<unknown>;
    watch?(scope: TaskScope, requestId: string): Promise<void>;
    unwatch?(scope: TaskScope, requestId: string): Promise<void>;
}
const terminal = (status: string) => ['completed', 'failed', 'stopped', 'cancelled'].includes(status);
const token = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export class AppTaskService {
    constructor(private deps: TaskDependencies) {}
    private check(s: TaskScope, detached = false) {
        if (s.userId !== this.deps.activeUser()) throw new AppError('E_CLOSED');
        if (!detached && s.signal.aborted) throw new AppError('E_CANCELLED');
    }
    private async file(s: TaskScope, requestId: string) {
        this.check(s);
        if (!safeId(s.userId) || !/^[a-f0-9]{64}$/.test(s.key) || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) throw new AppError('E_INPUT');
        return this.safeFile(s, path.join(webAppSandboxRoot(s.userId, s.key, 'cloud'), 'tasks', createHash('sha256').update(requestId).digest('hex') + '.json'));
    }
    private async safeFile(s: TaskScope, file: string) {
        const boundary = userCloudRoot(s.userId);
        if (!isPathAllowed(file, [boundary])) throw new AppError('E_FILE');
        for (let p = file; p !== boundary; p = path.dirname(p)) {
            try {
                const st = await fs.lstat(p);
                if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1)) throw new AppError('E_FILE');
            } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        }
        return file;
    }
    private async read(file: string, requestId: string): Promise<Receipt | null> {
        try {
            if ((await fs.stat(file)).size > 262144) throw new AppError('E_TASK');
            const v = JSON.parse(await fs.readFile(file, 'utf8'));
            if (![1, 2].includes(v.version) || v.requestId !== requestId || !/^[a-f0-9]{64}$/.test(v.fingerprint)
                || !['preparing', 'dispatching', 'submitted', 'rejected'].includes(v.phase) || (v.cid && !safeId(v.cid))
                || (v.sessionId && !token(v.sessionId)) || (v.result && (!terminal(v.result.status) || typeof v.result.text !== 'string' || !Array.isArray(v.result.files)))) throw new AppError('E_TASK');
            if (v.baseline !== undefined && (!Array.isArray(v.baseline) || v.baseline.length > 1000 || !v.baseline.every(safeId))) throw new AppError('E_TASK');
            if (v.output !== undefined && !validTaskOutput(v.deliverable, v.output)) throw new AppError('E_TASK');
            return v;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            if (e instanceof AppError) throw e;
            throw new AppError('E_TASK');
        }
    }
    private async save(s: TaskScope, file: string, v: Receipt) {
        await this.safeFile(s, file);
        await writeJson(file, v);
    }
    private async binding(s: TaskScope, sessionId: string) {
        if (!token(sessionId)) throw new AppError('E_INPUT');
        return this.safeFile(s, path.join(webAppSandboxRoot(s.userId, s.key, 'cloud'), 'tasks', 'sessions', sessionId + '.json'));
    }
    private async assertHost(s: TaskScope, hostId?: string) {
        if (hostId && this.deps.hostId && hostId !== await this.deps.hostId(s.userId)) throw new AppError('E_UNAVAILABLE');
    }
    private async readBinding(file: string): Promise<{ cid: string; requestId?: string; agentId: string; closed?: boolean; hostId?: string; media?: Start["media"] | null }> {
        try {
            if ((await fs.stat(file)).size > 4096) throw new Error();
            const v = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!safeId(v.cid) || typeof v.agentId !== 'string') throw new Error();
            return v;
        } catch { throw new AppError('E_TASK'); }
    }
    private admission(v: Receipt) {
        return { requestId: v.requestId, status: v.phase === 'submitted' ? 'submitted' : v.phase === 'rejected' ? 'rejected' : 'unknown',
            ...(v.sessionId ? { sessionId: v.sessionId } : {}) };
    }
    /** Host calls this independently of page lifetime. Every irreversible
     * cleanup follows a durable receipt. Retrying only repeats storage IO. */
    async settle(s: TaskScope, requestId: string): Promise<void> {
        const file = await this.file(s, requestId);
        await fileEditLock(file).runExclusive(async () => {
            this.check(s);
            const v = await this.read(file, requestId);
            if (!v?.cid || v.cleaned) { await this.deps.unwatch?.(s, requestId); return; }
            await this.assertHost(s, v.hostId);
            await this.deps.assertOwner?.(s.userId, v.cid, s, !!v.result, v.version === 1);
            if (!v.result) {
                let result = ['preparing', 'rejected'].includes(v.phase) ? { status: 'failed', text: '', files: [], ...(v.errorCode?{error:{code:v.errorCode}}:{}) } : await this.deps.inspect(s.userId, v.cid, v.messageId, v.baseline, v.cancelRequested || v.interactionRejected);
                if (v.directDelivery && !v.cancelRequested && result.status === 'waiting_input' && this.deps.rejectInteraction) {
                    // Persist the outcome before stopping a wait. A crash can repeat cancellation,
                    // never generation. Legacy receipts keep their original interactive contract.
                    v.interactionRejected = true;
                    await this.save(s, file, v);
                    if (!await this.deps.rejectInteraction(s.userId, v.cid)) return;
                    result = await this.deps.inspect(s.userId, v.cid, v.messageId, v.baseline, true);
                }
                if (v.cancelRequested && result.status === 'unknown') result.status = 'stopped';
                if (!terminal(result.status)) return;
                if (!this.deps.archive) return;
                if (v.interactionRejected && !v.cancelRequested) {
                    result.status = 'failed'; result.error = { code: 'E_INTERACTION_REQUIRED' };
                }
                if (result.status === 'completed' && v.deliverable && v.deliverable !== 'text' && !result.files.length) {
                    result.status = 'failed'; result.error = { code: 'E_OUTPUT_MISSING' };
                }
                v.result = await this.deps.archive(s.userId, v.cid, result, s, requestId, v.deliverable, v.output);
                delete v.baseline; delete v.messageId;
                this.check(s, true);
                v.version = 2;
                await this.save(s, file, v);
            }
            if (!v.keepSession) await this.deps.cleanup?.(s.userId, v.cid);
            if (v.sessionId) {
                const sessionFile = await this.binding(s, v.sessionId);
                await fileEditLock(sessionFile).runExclusive(async () => {
                    const binding = await this.readBinding(sessionFile);
                    if (binding.requestId === requestId) { delete binding.requestId; await writeJson(sessionFile, binding); }
                });
            }
            v.cleaned = true;
            await this.save(s, file, v);
            await this.deps.unwatch?.(s, requestId);
        });
    }
    async call(s: TaskScope, method: string, args: any): Promise<any> {
        const file = await this.file(s, args.requestId);
        if (method === 'tasks.start') return fileEditLock(file).runExclusive(async () => {
            this.check(s);
            if (args.sessionId && !args.keepSession) throw new AppError('E_INPUT');
            if (args.output !== undefined && !validTaskOutput(args.deliverable, args.output)) throw new AppError('E_INPUT');
            // Keep the v1 fingerprint for unchanged one-shot callers.
            const fields = [args.title, args.agentId, args.prompt, args.files];
            if (args.keepSession || args.sessionId) fields.push(args.keepSession, args.sessionId || '');
            if(args.media)fields.push({kind:args.media.kind,serviceId:args.media.serviceId});
            if(args.deliverable)fields.push({deliverable:args.deliverable});
            if(args.output)fields.push({output:{...(args.output.aspect?{aspect:args.output.aspect}:{}),...(args.output.format?{format:args.output.format}:{})}});
            const fingerprint = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
            const existing = await this.read(file, args.requestId);
            if (existing) {
                if (existing.fingerprint !== fingerprint) throw new AppError('E_CONFLICT');
                return this.admission(existing);
            }
            const admit = async (bindingFile?: string) => {
                const binding = bindingFile ? await this.readBinding(bindingFile) : null;
                if (binding) await this.assertHost(s, binding.hostId);
                if (binding && (binding.closed || binding.agentId !== args.agentId)) throw new AppError('E_CONFLICT');
                if (binding?.requestId) throw new AppError('E_BUSY');
                if (binding && JSON.stringify(binding.media ?? null) !== JSON.stringify(args.media ? {kind:args.media.kind,serviceId:args.media.serviceId} : null)) throw new AppError('E_CONFLICT');
                const v: Receipt = { version: 2, requestId: args.requestId, fingerprint, phase: 'preparing', createdAt: new Date().toISOString(),
                    ...(!args.keepSession ? { directDelivery: true } : {}), ...(args.deliverable ? { deliverable: args.deliverable } : {}),
                    ...(args.output ? {output:args.output} : {}),
                    ...(args.keepSession ? { keepSession: true } : {}), ...(args.sessionId ? { sessionId: args.sessionId } : {}) };
                if (!binding) v.cid = this.deps.reserve?.(s, args);
                v.hostId = await this.deps.hostId?.(s.userId);
                // Register the durable recovery intent before creating any execution data.
                await this.deps.watch?.(s, args.requestId);
                await this.save(s, file, v);
                this.check(s);
                try {
                    if (binding) { v.cid = binding.cid; await this.deps.assertOwner?.(s.userId, binding.cid, s); }
                    else {
                        const conv = await this.deps.create(s.userId, args.title, s, args, v.cid);
                        v.cid = conv.conversation_id;
                        if (args.keepSession) v.sessionId = conv.sessionId;
                    }
                    if (v.sessionId) {
                        const target = bindingFile || await this.binding(s, v.sessionId);
                        await writeJson(target, { cid: v.cid, requestId: v.requestId, agentId: args.agentId, media: args.media ? {kind:args.media.kind,serviceId:args.media.serviceId} : null, ...(v.hostId ? { hostId: v.hostId } : {}) });
                    }
                    v.baseline = await this.deps.checkpoint?.(s.userId, v.cid!);
                    v.phase = 'dispatching';
                    await this.save(s, file, v);
                    this.check(s, true);
                    // Once admitted, page detachment cannot interrupt preparation/send.
                    const admittedScope = { ...s, signal: new AbortController().signal };
                    const sent = await this.deps.send(s.userId, v.cid!, args, admittedScope);
                    if (!sent.ok) throw new AppError('E_TASK_UNCERTAIN');
                    v.messageId = sent.msg?.id;
                    v.phase = 'submitted';
                    await this.save(s, file, v);
                    return this.admission(v);
                } catch (cause) {
                    if (cause instanceof TaskInputError) {
                        v.phase = 'rejected';v.errorCode=/^E_[A-Z0-9_]{1,60}$/.test(cause.code)?cause.code:'E_INPUT'; await this.save(s, file, v); throw cause;
                    }
                    throw new AppError('E_TASK_UNCERTAIN');
                }
            };
            if (args.sessionId) {
                const binding = await this.binding(s, args.sessionId);
                return fileEditLock(binding).runExclusive(() => admit(binding));
            }
            return admit();
        });
        const v = await this.read(file, args.requestId);
        this.check(s);
        if (!v) throw new AppError('E_TASK');
        if (method === 'tasks.open') throw new AppError('E_UNAVAILABLE');
        if (v.phase === 'rejected' && method === 'tasks.get') return { requestId: v.requestId, status: 'failed', text: '', files: [], ...(v.errorCode?{error:{code:v.errorCode}}:{}) };
        if (!v.cid) {
            if (method === 'tasks.get') return { requestId: args.requestId, status: 'unknown', text: '', files: [] };
            throw new AppError('E_TASK_UNCERTAIN');
        }
        await this.deps.assertOwner?.(s.userId, v.cid, s, !!v.result, v.version === 1);
        if (!v.result || ['tasks.respond', 'tasks.release'].includes(method)) await this.assertHost(s, v.hostId);
        if (method === 'tasks.get') {
            const result = v.result || await this.deps.inspect(s.userId, v.cid, v.messageId, v.baseline, v.cancelRequested);
            this.check(s);
            if (v.directDelivery) {
                const { form: _form, interactions: _interactions, inputId: _inputId, ...visible } = result;
                return { requestId: v.requestId, ...visible, status: result.status === 'waiting_input' ? 'running' : result.status, saved: !!v.result };
            }
            return { requestId: v.requestId, ...result, saved: !!v.result, ...(v.sessionId ? { sessionId: v.sessionId } : {}) };
        }
        if (method === 'tasks.cancel') {
            await fileEditLock(file).runExclusive(async () => {
                const current = await this.read(file, args.requestId);
                if (!current?.cid || current.result) return;
                await this.deps.cancel(s.userId, current.cid);
                current.cancelRequested = true; await this.save(s, file, current);
            });
            return { cancelRequested: true };
        }
        if (method === 'tasks.respond' && this.deps.respond) return fileEditLock(file).runExclusive(async () => {
            const current = await this.read(file, args.requestId);
            this.check(s);
            if (!current?.cid || current.result || current.cancelRequested || current.directDelivery) throw new AppError('E_TASK');
            await this.deps.assertOwner?.(s.userId, current.cid, s, false, current.version === 1);
            const result = await this.deps.respond!(s.userId, current.cid, args, { messageId: current.messageId, baseline: current.baseline }) as { handled?: boolean; messageId?: string };
            if (result.messageId) { current.messageId = result.messageId; await this.save(s, file, current); }
            return { handled: result.handled !== false };
        });
        if (method === 'tasks.release' && v.keepSession && v.sessionId) {
            if (!v.cleaned) throw new AppError('E_BUSY');
            const bindingFile = await this.binding(s, v.sessionId);
            return fileEditLock(bindingFile).runExclusive(async () => {
                const binding = await this.readBinding(bindingFile);
                if (binding.requestId) throw new AppError('E_BUSY');
                await this.deps.cleanup?.(s.userId, v.cid!);
                binding.closed = true; await writeJson(bindingFile, binding);
                return { released: true };
            });
        }
        if (method === 'tasks.output' && this.deps.output) {
            const result = await this.deps.output(s.userId, v.cid, args.outputId, v.result, s);
            this.check(s);
            return result;
        }
        throw new AppError('E_METHOD');
    }
}
