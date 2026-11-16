/** Bounded durable finalization journal. It contains routing identities only;
 * recovery performs storage/cleanup, never another Agent send. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { userLocalRoot } from '../../paths';
import { writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { randomBytes } from 'node:crypto';
import { AppError } from './runtime';
import type { TaskScope } from './tasks';
interface Pending { key: string; requestId: string }
const fileFor = (uid: string) => path.join(userLocalRoot(uid), 'web_apps', 'task-pending.json');
export async function appTaskHostId(uid: string): Promise<string> {
    await guard(uid);
    const file = path.join(path.dirname(fileFor(uid)), 'host.json');
    return fileEditLock(file).runExclusive(async () => {
        try {
            const st = await fs.lstat(file);
            if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1024) throw new AppError('E_FILE');
            const v = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!/^[a-f0-9]{32}$/.test(v.id)) throw new AppError('E_FILE');
            return v.id;
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            const id = randomBytes(16).toString('hex'); await writeJson(file, { version: 1, id }); return id;
        }
    });
}
async function guard(uid: string): Promise<void> {
    for (let file = fileFor(uid); ; file = path.dirname(file)) {
        try { const st = await fs.lstat(file); if (st.isSymbolicLink() || st.isFile() && st.nlink !== 1) throw new AppError('E_FILE'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (file === userLocalRoot(uid)) return;
    }
}
async function read(uid: string): Promise<Pending[]> {
    await guard(uid);
    const file = fileFor(uid);
    try {
        const st = await fs.lstat(file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 32768) throw new AppError('E_FILE');
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 128
            || value.items.some((v: Pending) => !/^[a-f0-9]{64}$/.test(v.key) || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.requestId))) throw new AppError('E_TASK');
        return value.items;
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export async function pendingTask(uid: string, key: string, requestId: string, add: boolean): Promise<void> {
    const file = fileFor(uid);
    await fileEditLock(file).runExclusive(async () => {
        const items = await read(uid), at = items.findIndex(v => v.key === key && v.requestId === requestId);
        if (add && at >= 0 || !add && at < 0) return;
        if (add) { if (items.length >= 128) throw new AppError('E_BUSY'); items.push({ key, requestId }); }
        else items.splice(at, 1);
        await writeJson(file, { version: 1, items });
    });
}
export async function drainPendingTasks(uid: string, activeUser: () => string, settle: (s: TaskScope, requestId: string) => Promise<void>, failure: (code: string) => void): Promise<void> {
    for (const v of await read(uid)) {
        if (activeUser() !== uid) return;
        try { await settle({ userId: uid, key: v.key, signal: new AbortController().signal }, v.requestId); }
        catch (e) { failure(e instanceof AppError ? e.code : 'E_SAVE'); }
    }
}
