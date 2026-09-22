/** Native asynchronous questions keep their own reply identity. A click may
 * only address the captured live turn; it must never wake a replacement turn.
 * Keep an accepted delivery across a failed history write so retrying the
 * save cannot send the same answer to the CLI twice. */
import type { LocalActiveRunIngress, LocalCliAsyncQuestion } from '../local_agents/backends/base';
import type { GroupMessage } from './visibility';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.cli_async_input');

type Entry = {
  uid: string;
  cid: string;
  turnId: string;
  messageId: string;
  questions: LocalCliAsyncQuestion[];
  ingress: () => LocalActiveRunIngress | null;
  save: (text: string, answers: string[], inputId: string) => Promise<GroupMessage>;
  saveCancelled: () => Promise<GroupMessage>;
  inputId: string;
  accepted?: { text: string; answers: string[] };
  saved?: GroupMessage;
  submitting?: Promise<AsyncInputResult>;
  cancelling?: Promise<AsyncInputResult>;
  cancelled?: GroupMessage;
  closed?: boolean;
};

export type AsyncInputResult =
  | { ok: true; message: GroupMessage }
  | { ok: false; error: 'expired' | 'invalid_answers' | 'delivery_failed' | 'save_failed' | 'already_answered' | 'cancelled' };

const entries = new Map<string, Entry>();
const key = (uid: string, cid: string, messageId: string) => JSON.stringify([uid, cid, messageId]);

export function registerCliAsyncInput(entry: Entry): void {
  entries.set(key(entry.uid, entry.cid, entry.messageId), entry);
}

export function closeCliAsyncInputs(uid: string, cid: string, turnId?: string): void {
  for (const [id, entry] of entries) {
    if (entry.uid !== uid || entry.cid !== cid || (turnId && entry.turnId !== turnId)) continue;
    // Accepted answers whose persistence is still pending may only retry that
    // write. Ordinary questions become expired when the owning turn ends.
    if (turnId && entry.accepted && !entry.saved) continue;
    entries.delete(id);
  }
}

/** Finish accepted history writes before publishing the terminal reply. */
export async function finishCliAsyncInputs(uid: string, cid: string, turnId: string): Promise<void> {
  const pending: Promise<AsyncInputResult>[] = [];
  for (const entry of entries.values()) {
    if (entry.uid !== uid || entry.cid !== cid || entry.turnId !== turnId) continue;
    entry.closed = true;
    if (entry.submitting) pending.push(entry.submitting);
    if (entry.cancelling) pending.push(entry.cancelling);
  }
  await Promise.all(pending);
  closeCliAsyncInputs(uid, cid, turnId);
}

export async function answerCliAsyncInput(
  uid: string, cid: string, messageId: string, rawAnswers: unknown,
): Promise<AsyncInputResult> {
  const entry = entries.get(key(uid, cid, messageId));
  if (!entry) return { ok: false, error: 'expired' };
  if (entry.cancelling) await entry.cancelling;
  if (entry.cancelled) return { ok: false, error: 'cancelled' };
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== entry.questions.length
      || rawAnswers.some(value => typeof value !== 'string' || !value.trim() || value.length > 4000)) {
    return { ok: false, error: 'invalid_answers' };
  }
  const answers = rawAnswers as string[];
  if (entry.submitting) {
    await entry.submitting;
    if (entry.saved) return JSON.stringify(entry.accepted?.answers) === JSON.stringify(answers)
      ? { ok: true, message: entry.saved } : { ok: false, error: 'already_answered' };
    return answerCliAsyncInput(uid, cid, messageId, answers);
  }
  if (entry.accepted && JSON.stringify(entry.accepted.answers) !== JSON.stringify(answers)) {
    return { ok: false, error: 'already_answered' };
  }
  if (entry.saved) return { ok: true, message: entry.saved };
  entry.submitting = (async (): Promise<AsyncInputResult> => {
    if (!entry.accepted) {
      const ingress = entry.ingress();
      if (entry.closed || !ingress) return { ok: false, error: 'expired' };
      const text = entry.questions.map((question, i) => `${question.title}\n${answers[i]}`).join('\n\n');
      try {
        const result = await ingress.submit({ id: entry.inputId, text });
        if (result.mode !== 'steered') return { ok: false, error: 'delivery_failed' };
      } catch {
        return { ok: false, error: 'delivery_failed' };
      }
      entry.accepted = { text, answers: answers.slice() };
    }
    try {
      entry.saved = await entry.save(entry.accepted.text, entry.accepted.answers, entry.inputId);
      return { ok: true, message: entry.saved };
    } catch {
      return { ok: false, error: 'save_failed' };
    }
  })();
  try { return await entry.submitting; }
  finally { delete entry.submitting; }
}

/** Dismiss only this question. Never deliver a synthetic answer or stop the run. */
export async function cancelCliAsyncInput(
  uid: string, cid: string, messageId: string,
): Promise<AsyncInputResult> {
  const entry = entries.get(key(uid, cid, messageId));
  if (!entry) return { ok: false, error: 'expired' };
  if (entry.cancelling) return entry.cancelling;
  if (entry.submitting) {
    await entry.submitting;
    return cancelCliAsyncInput(uid, cid, messageId);
  }
  if (entry.saved) return { ok: true, message: entry.saved };
  // Delivery cannot be undone, even when its history write still needs retrying.
  if (entry.accepted) return { ok: false, error: 'already_answered' };
  if (entry.cancelled) return { ok: true, message: entry.cancelled };
  if (entry.closed) return { ok: false, error: 'expired' };
  entry.cancelling = (async (): Promise<AsyncInputResult> => {
    try {
      entry.cancelled = await entry.saveCancelled();
      return { ok: true, message: entry.cancelled };
    } catch {
      log.warn('question cancellation save failed');
      return { ok: false, error: 'save_failed' };
    }
  })();
  try { return await entry.cancelling; }
  finally { delete entry.cancelling; }
}
