import type { Tray } from 'electron';
import { subscribeTaskTerminals, type TaskTerminalEvent } from './group_chat/bus';

type TrayUnreadRuntime = {
  tray: Pick<Tray, 'setTitle'>;
  getActiveUserId: () => string;
  isEnabled: () => boolean;
  isMainWindowFocused: () => boolean;
  warn: (message: string) => void;
};

const MAX_UNREAD_CONVERSATIONS = 500;
let runtime: TrayUnreadRuntime | null = null;
let ownerUserId = '';
// This set belongs to the current absence, independently of persisted sidebar dots.
const unreadCids = new Set<string>();
let stopTerminals: (() => void) | null = null;

function activeUserId(): string {
  try { return runtime?.getActiveUserId() || ''; } catch { return ''; }
}

function ensureOwner(): void {
  if (!runtime) return;
  const nextUserId = activeUserId();
  if (nextUserId === ownerUserId) return;
  ownerUserId = nextUserId;
  unreadCids.clear();
}

function render(): void {
  if (!runtime) return;
  ensureOwner();
  try {
    if (runtime.isMainWindowFocused()) unreadCids.clear();
    const count = runtime.isEnabled() ? unreadCids.size : 0;
    runtime.tray.setTitle(count > 99 ? '99+' : count > 0 ? String(count) : '');
  } catch {
    try { runtime.warn('tray unread title unavailable'); } catch { /* optional tray */ }
  }
}

function onTerminal(event: TaskTerminalEvent): void {
  if (!runtime || runtime.isMainWindowFocused()) return;
  if (!['completed', 'stopped', 'failed', 'waiting_input'].includes(event.status)) return;
  ensureOwner();
  if (!ownerUserId || event.user_id !== ownerUserId || !event.conversation_id
      || unreadCids.has(event.conversation_id) || unreadCids.size >= MAX_UNREAD_CONVERSATIONS) return;
  unreadCids.add(event.conversation_id);
  render();
}

export function refreshTaskUnreadTray(): void {
  render();
}

export function resetTaskUnreadTrayOwner(): void {
  if (!runtime) return;
  const nextUserId = activeUserId();
  if (nextUserId === ownerUserId) return;
  ownerUserId = nextUserId;
  unreadCids.clear();
  render();
}

export function startTaskUnreadTray(nextRuntime: TrayUnreadRuntime): () => void {
  stopTerminals?.();
  runtime = nextRuntime;
  ownerUserId = activeUserId();
  unreadCids.clear();
  render();
  const unsubscribe = subscribeTaskTerminals(onTerminal);
  stopTerminals = unsubscribe;
  return () => {
    unsubscribe();
    if (stopTerminals === unsubscribe) stopTerminals = null;
    if (runtime === nextRuntime) {
      try { nextRuntime.tray.setTitle(''); } catch { /* tray may already be destroyed */ }
      runtime = null;
      ownerUserId = '';
      unreadCids.clear();
    }
  };
}
