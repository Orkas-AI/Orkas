/** Blocking structured-input bridge for native CLI protocols.
 *
 * Codex app-server can issue `item/tool/requestUserInput` while a turn is
 * running. Main owns the pending promise, renderer collects bounded answers,
 * and cancellation/user switch/app shutdown always resolves with empty
 * answers so the native process never waits forever. Raw answers are neither
 * logged nor published as LocalEvents.
 */

import * as crypto from 'node:crypto';

import { createLogger } from '../../logger.js';
import { logErrorSummary, maskId } from '../../util/log-redact.js';
import { registerUserSwitchHook } from '../user-switch-hooks.js';
import type {
  LocalCliUserInputQuestion,
  LocalCliUserInputRequest,
  LocalCliUserInputResponse,
} from './backends/base.js';
import type { LocalCliType } from './registry.js';

const log = createLogger('local-agents:user-input');
const WAITING_HEARTBEAT_MS = 25_000;
const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 12;
const MAX_LABEL = 160;
const MAX_TEXT = 2_000;
const MAX_ANSWER = 4_000;

interface Pending {
  uid: string;
  runId: string;
  questionIds: string[];
  resolve: (response: LocalCliUserInputResponse) => void;
  heartbeat?: NodeJS.Timeout;
  autoResolve?: NodeJS.Timeout;
  detachAbort?: () => void;
  cancel?: LocalCliUserInputRequest['cancel'];
  cancelUncertain?: boolean;
  cancelling?: Promise<{ handled: boolean; cancelled?: boolean; closed?: boolean; cancel_failed?: boolean; unknown?: boolean }>;
}

const pending = new Map<string, Pending>();
type BroadcastOverride = (channel: string, payload: unknown) => void | boolean;
let broadcastOverride: BroadcastOverride | null = null;

function bounded(value: unknown, max: number): string {
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
    : '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeQuestions(raw: LocalCliUserInputQuestion[], limit = MAX_QUESTIONS): LocalCliUserInputQuestion[] {
  const seen = new Set<string>();
  const questions: LocalCliUserInputQuestion[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (questions.length >= limit) break;
    const id = bounded(item?.id, MAX_LABEL);
    const question = bounded(item?.question, MAX_TEXT);
    if (!id || !question || seen.has(id)) continue;
    seen.add(id);
    const options = (Array.isArray(item.options) ? item.options : [])
      .slice(0, MAX_OPTIONS)
      .map(option => ({
        label: bounded(option?.label, MAX_LABEL),
        description: bounded(option?.description, MAX_TEXT),
      }))
      .filter(option => option.label)
      .map(option => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      }));
    questions.push({
      id,
      question,
      ...(bounded(item.header, MAX_LABEL) ? { header: bounded(item.header, MAX_LABEL) } : {}),
      ...(options.length ? { options } : {}),
      ...(item.isOther === true ? { isOther: true } : {}),
      ...(item.isSecret === true ? { isSecret: true } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

function broadcast(channel: string, payload: unknown): boolean {
  try {
    if (broadcastOverride) return broadcastOverride(channel, payload) !== false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (name: string, body: unknown) => boolean };
    return ipc.broadcastToRenderer?.(channel, payload) === true;
  } catch {
    return false;
  }
}

function emptyResponse(questionIds: string[]): LocalCliUserInputResponse {
  return {
    cancelled: true,
    answers: Object.fromEntries(questionIds.map(id => [id, []])),
  };
}

function settle(requestId: string, response: LocalCliUserInputResponse): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  if (entry.heartbeat) clearInterval(entry.heartbeat);
  if (entry.autoResolve) clearTimeout(entry.autoResolve);
  entry.detachAbort?.();
  entry.resolve(response);
  return true;
}

export async function requestUserInput(opts: {
  uid: string;
  cid: string;
  runId: string;
  agentId: string;
  agentName: string;
  conversationTitle?: string;
  cli: LocalCliType;
  request: LocalCliUserInputRequest;
  onWaiting?: (elapsedMs: number) => void;
}): Promise<LocalCliUserInputResponse> {
  const questions = normalizeQuestions(opts.request.questions, opts.cli === 'claude' ? 4 : MAX_QUESTIONS);
  const questionIds = questions.map(question => question.id);
  if (!questions.length || opts.request.signal?.aborted) return emptyResponse(questionIds);
  const requestId = crypto.randomBytes(8).toString('hex');
  const payload = {
    request_id: requestId,
    cid: opts.cid,
    agent_id: opts.agentId,
    agent_name: bounded(opts.agentName || opts.agentId, MAX_LABEL),
    conversation_title: bounded(opts.conversationTitle, MAX_LABEL),
    cli: opts.cli,
    questions,
    is_blocking: opts.request.isBlocking !== false,
  };

  log.info('external CLI requested user input', {
    request_id: maskId(requestId),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    cli: opts.cli,
    question_count: questions.length,
    blocking: payload.is_blocking,
  });

  return new Promise<LocalCliUserInputResponse>((resolve) => {
    const startedAt = Date.now();
    const notifyWaiting = () => {
      try { opts.onWaiting?.(Date.now() - startedAt); }
      catch (error) {
        log.warn('external CLI user-input waiting callback failed', {
          request_id: maskId(requestId),
          error: logErrorSummary(error),
        });
      }
    };
    const entry: Pending = { uid: opts.uid, runId: opts.runId, questionIds, resolve, cancel: opts.request.cancel };
    pending.set(requestId, entry);
    const cancel = () => {
      if (settle(requestId, emptyResponse(questionIds))) {
        broadcast('local-agent:user-input_cancelled', { request_ids: [requestId] });
      }
    };
    const signal = opts.request.signal;
    if (signal) {
      signal.addEventListener('abort', cancel, { once: true });
      entry.detachAbort = () => signal.removeEventListener('abort', cancel);
    }
    if (!broadcast('local-agent:user-input', payload)) {
      settle(requestId, emptyResponse(questionIds));
      return;
    }
    if (!pending.has(requestId)) return;
    notifyWaiting();
    if (!pending.has(requestId)) return;
    if (opts.onWaiting) {
      entry.heartbeat = setInterval(notifyWaiting, WAITING_HEARTBEAT_MS);
      entry.heartbeat.unref?.();
    }
    // Legacy Codex requests may explicitly delegate auto-resolution to the
    // client. Absence of a protocol deadline never implies a host timeout.
    const rawAutoMs = opts.request.autoResolutionMs;
    if (Number.isFinite(rawAutoMs) && Number(rawAutoMs) >= 0) {
      entry.autoResolve = setTimeout(cancel, Number(rawAutoMs));
      entry.autoResolve.unref?.();
    }
  });
}

export function respond(
  requestId: string,
  uid: string,
  rawAnswers: unknown,
  cancelled = false,
): { handled: boolean; cancelled?: boolean } {
  const entry = pending.get(requestId);
  if (!entry || entry.uid !== uid) return { handled: false };
  if (entry.cancelling || entry.cancelUncertain) return { handled: false };
  const record = rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
    ? rawAnswers as Record<string, unknown>
    : {};
  const answers: Record<string, string[]> = {};
  for (const id of entry.questionIds) {
    const value = record[id];
    const values = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    answers[id] = cancelled
      ? []
      : values.slice(0, MAX_OPTIONS).map(item => bounded(item, MAX_ANSWER)).filter(Boolean);
  }
  settle(requestId, { cancelled, answers });
  return { handled: true, cancelled };
}

/** Keep ownership until the native question is confirmed closed. A retry after
 * a lost IPC response may find no pending request; report closed, not success. */
export async function cancelRequest(requestId: string, uid: string): Promise<{
  handled: boolean; cancelled?: boolean; closed?: boolean; cancel_failed?: boolean; unknown?: boolean;
}> {
  const entry = pending.get(requestId);
  if (!entry) return { handled: false, closed: true };
  if (entry.uid !== uid) return { handled: false };
  if (!entry.cancel) return { handled: false, cancel_failed: true };
  if (entry.cancelUncertain) return { handled: false, unknown: true };
  if (entry.cancelling) return entry.cancelling;
  entry.cancelling = (async () => {
    let result: 'cancelled' | 'closed' | 'failed' | 'unknown';
    try { result = await entry.cancel!(); } catch { result = 'unknown'; }
    if (result === 'failed') return { handled: false, cancel_failed: true };
    if (result !== 'cancelled' && result !== 'closed') {
      entry.cancelUncertain = true;
      return { handled: false, unknown: true };
    }
    settle(requestId, emptyResponse(entry.questionIds));
    return result === 'cancelled'
      ? { handled: true, cancelled: true }
      : { handled: false, closed: true };
  })();
  try { return await entry.cancelling; }
  finally { entry.cancelling = undefined; }
}

export function cancelForRun(runId: string): void {
  const requestIds: string[] = [];
  for (const [requestId, entry] of pending) {
    if (entry.runId !== runId) continue;
    requestIds.push(requestId);
    settle(requestId, emptyResponse(entry.questionIds));
  }
  if (requestIds.length) broadcast('local-agent:user-input_cancelled', { request_ids: requestIds });
}

function cancelForUid(uid: string): void {
  const runIds = new Set<string>();
  for (const entry of pending.values()) if (entry.uid === uid) runIds.add(entry.runId);
  for (const runId of runIds) cancelForRun(runId);
}

registerUserSwitchHook('local-agent-user-input', previousUid => cancelForUid(previousUid));

export function _setBroadcastForTest(fn: BroadcastOverride | null): void {
  broadcastOverride = fn;
}

export function _resetForTest(): void {
  for (const [requestId, entry] of pending) settle(requestId, emptyResponse(entry.questionIds));
  pending.clear();
  broadcastOverride = null;
}
