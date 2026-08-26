/**
 * Content-free signals for in-progress tasks that have reached a real user
 * action gate. Producers may live in model, feature, or IPC code, so this
 * registry deliberately has no Electron or feature dependency.
 *
 * The native task-notification feature is the only production consumer. It
 * applies account, preference, foreground, and OS-support policy; publishing
 * here never implies that a system notification will be shown.
 */

import { createLogger } from '../logger';

const log = createLogger('task-intervention-events');

export type TaskInterventionKind =
  | 'sensitive_operation'
  | 'connector_permission'
  | 'connector_install'
  | 'delete_confirmation'
  | 'interactive_cli_input';

export interface TaskInterventionEvent {
  attention_id: string;
  user_id: string;
  conversation_id: string;
  kind: TaskInterventionKind;
}

export type TaskInterventionListener = (event: TaskInterventionEvent) => void;

const _TASK_INTERVENTION_LISTENERS_KEY = Symbol.for('orkas.task_intervention.listeners');
const _listeners: Set<TaskInterventionListener> =
  ((globalThis as any)[_TASK_INTERVENTION_LISTENERS_KEY] ??= new Set<TaskInterventionListener>());
const _INTERACTIVE_WAITING_KEY = Symbol.for('orkas.task_intervention.interactive_waiting');
const _interactiveWaiting: Set<string> =
  ((globalThis as any)[_INTERACTIVE_WAITING_KEY] ??= new Set<string>());

export function subscribeTaskInterventions(listener: TaskInterventionListener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function emitTaskIntervention(event: TaskInterventionEvent): void {
  if (!event.attention_id || !event.user_id || !event.conversation_id) return;
  for (const listener of _listeners) {
    try { listener(event); }
    catch (error) {
      // An attention layer must never break the gated task operation.
      log.warn('task intervention listener failed', { error });
    }
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? String(record[key]).trim() : '';
}

/**
 * Convert only delivered renderer action surfaces into task intervention
 * signals. Calling this after `webContents.send` succeeds prevents false
 * notifications for permission paths that already failed closed because no
 * renderer could show the action.
 */
export function captureDeliveredTaskIntervention(
  channel: string,
  payload: unknown,
  activeUserId: string,
): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const activeUid = String(activeUserId || '').trim();

  const requestKinds: Record<string, TaskInterventionKind> = {
    'bash:permission': 'sensitive_operation',
    'bridge:permission': 'connector_permission',
    'connectors:install-confirm': 'connector_install',
    'delete_file.confirmation_required': 'delete_confirmation',
  };
  const requestKind = requestKinds[channel];
  if (requestKind) {
    const requestId = stringField(record, channel === 'delete_file.confirmation_required'
      ? 'confirm_id'
      : 'request_id');
    const conversationId = stringField(record, 'cid');
    if (!requestId || !activeUid || !conversationId) return false;
    emitTaskIntervention({
      attention_id: `${requestKind}:${requestId}`,
      user_id: activeUid,
      conversation_id: conversationId,
      kind: requestKind,
    });
    return true;
  }

  if (channel !== 'interactive-cli:event') return false;
  const type = stringField(record, 'type');
  const sessionId = stringField(record, 'session_id');
  if (!sessionId) return false;
  if (type === 'exited' || type === 'error' || type === 'closed') {
    _interactiveWaiting.delete(sessionId);
    return false;
  }
  if (type !== 'waiting_input' || _interactiveWaiting.has(sessionId)) return false;
  const userId = stringField(record, 'user_id') || activeUid;
  const conversationId = stringField(record, 'conversation_id');
  if (!userId || !conversationId) return false;
  _interactiveWaiting.add(sessionId);
  emitTaskIntervention({
    attention_id: `interactive_cli_input:${sessionId}`,
    user_id: userId,
    conversation_id: conversationId,
    kind: 'interactive_cli_input',
  });
  return true;
}

export function _resetTaskInterventionsForTest(): void {
  _listeners.clear();
  _interactiveWaiting.clear();
}
