/** Private projection of existing approval gates. No grant or decision lives
 * here: the owning permission modules still validate and settle responses. */
import { appConversationOwner } from '../paths';
export interface AppTaskInteraction { id: string; kind: string; payload: Record<string, any> }
const prompts = new Map<string, Map<string, AppTaskInteraction>>();
const answered = new Map<string, number>();
const ownerKey = (uid: string, cid: string) => `${uid}\0${cid}`;
const kinds = new Set(['bash:permission', 'connectors:action-confirm', 'local-agent:permission', 'local-agent:user-input', 'delete_file.confirmation_required']);
export function captureAppTaskEvent(uid: string, kind: string, raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const payload = raw as Record<string, any>;
    if (kind === 'delete_file.confirmation_required' && typeof payload.confirm_id === 'string') payload.request_id = payload.confirm_id;
    if (kind === 'delete_file.confirmation_invalidated' && typeof payload.confirm_id === 'string') payload.request_ids = [payload.confirm_id];
    const cid = typeof payload.cid === 'string' ? payload.cid : '';
    let consumed = false;
    if (Array.isArray(payload.request_ids)) {
        const handled = new Set<string>();
        for (const [key, entries] of prompts) {
            if (!key.startsWith(uid + '\0')) continue;
            for (const id of payload.request_ids) if (entries.delete(id)) handled.add(id);
            if (!entries.size) prompts.delete(key);
        }
        for (const [key, time] of answered) if (Date.now() - time > 600000) answered.delete(key);
        for (const id of payload.request_ids) if (answered.delete(uid + '\0' + id)) handled.add(id);
        if (handled.size) {
            payload.request_ids = payload.request_ids.filter((id: string) => !handled.has(id));
            consumed = payload.request_ids.length === 0;
        }
    }
    if (!appConversationOwner(cid)) return consumed;
    if (kinds.has(kind) && typeof payload.request_id === 'string') {
        const key = ownerKey(uid, cid);
        let entries = prompts.get(key);
        if (!entries) { if (prompts.size >= 128) return true; entries = new Map(); prompts.set(key, entries); }
        if (entries.size >= 16 && !entries.has(payload.request_id)) return true;
        const { cid: _cid, uid: _uid, user_id: _user, ...visible } = payload;
        entries.set(payload.request_id, { id: payload.request_id, kind, payload: visible });
    }
    return true;
}
export function appTaskInteractions(uid: string, cid: string): AppTaskInteraction[] {
    return [...(prompts.get(ownerKey(uid, cid))?.values() || [])].map(v => structuredClone(v));
}
export function takeAppTaskInteraction(uid: string, cid: string, id: string): AppTaskInteraction | null {
    const entries = prompts.get(ownerKey(uid, cid)), value = entries?.get(id);
    if (!value) return null;
    entries!.delete(id);
    if (!entries!.size) prompts.delete(ownerKey(uid, cid));
    if (answered.size >= 2048) answered.delete(answered.keys().next().value!);
    answered.set(uid + '\0' + id, Date.now());
    return value;
}
export function clearAppTaskEvents(uid: string, cid: string): void { prompts.delete(ownerKey(uid, cid)); }
