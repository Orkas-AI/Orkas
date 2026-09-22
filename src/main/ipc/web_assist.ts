/** Renderer-only IPC adapter for the platform Web Assist component. */

import type { WebContents } from 'electron';

import {
  activateWebAssistTab,
  addWebAssistTab,
  closeWebAssistTab,
  closeWebAssist,
  captureWebAssistPreview,
  layoutWebAssist,
  navigateWebAssist,
  navigateWebAssistTo,
  openWebAssist,
  openWebAssistInDefaultBrowser,
  allowWebAssistDownloadOrigin,
  setActiveWebAssistConversation,
  webAssistDownloads,
  webAssistNavigations,
  webAssistState,
} from '../features/web_assist';

interface WebAssistIpcContext {
  userId: string;
  sender: WebContents;
}

export const invokeHandlers = {
  'webAssist.open': async (
    payload: { url?: unknown; label?: unknown; conversationId?: unknown; tabId?: unknown },
    ctx: WebAssistIpcContext,
  ) => openWebAssist(ctx.userId, ctx.sender, payload || {}),

  'webAssist.addTab': async (
    payload: { conversationId?: unknown; label?: unknown; ifEmpty?: unknown },
    ctx: WebAssistIpcContext,
  ) => addWebAssistTab(ctx.userId, ctx.sender, payload || {}),

  'webAssist.activateTab': async (
    payload: { tabId?: unknown },
    ctx: WebAssistIpcContext,
  ) => activateWebAssistTab(ctx.sender, payload?.tabId),

  'webAssist.closeTab': async (
    payload: { tabId?: unknown },
    ctx: WebAssistIpcContext,
  ) => closeWebAssistTab(ctx.sender, payload?.tabId),

  'webAssist.navigateTo': async (
    payload: { tabId?: unknown; url?: unknown },
    ctx: WebAssistIpcContext,
  ) => navigateWebAssistTo(ctx.sender, payload || {}),

  'webAssist.setContext': async (
    payload: { conversationId?: unknown },
    ctx: WebAssistIpcContext,
  ) => setActiveWebAssistConversation(ctx.sender, payload?.conversationId),

  'webAssist.layout': async (
    payload: { x?: unknown; y?: unknown; width?: unknown; height?: unknown; visible?: unknown },
    ctx: WebAssistIpcContext,
  ) => layoutWebAssist(ctx.sender, payload),

  'webAssist.capturePreview': async (payload: { tabId?: unknown }, ctx: WebAssistIpcContext) => (
    captureWebAssistPreview(ctx.sender, payload?.tabId)
  ),

  'webAssist.navigate': async (
    payload: { action?: unknown },
    ctx: WebAssistIpcContext,
  ) => navigateWebAssist(ctx.sender, payload?.action),

  'webAssist.openExternal': async (_payload: unknown, ctx: WebAssistIpcContext) => (
    openWebAssistInDefaultBrowser(ctx.sender)
  ),

  'webAssist.close': async (_payload: unknown, ctx: WebAssistIpcContext) => closeWebAssist(ctx.sender),

  'webAssist.state': async (_payload: unknown, ctx: WebAssistIpcContext) => webAssistState(ctx.sender),

  /** Where this task's browser has been under model control. Read-only, and
   *  chrome rather than model output, so it may carry full addresses. */
  'webAssist.navigations': async (
    payload: { conversation_id?: unknown },
    ctx: WebAssistIpcContext,
  ) => webAssistNavigations(
    ctx.userId,
    typeof payload?.conversation_id === 'string' ? payload.conversation_id : '',
  ),

  /** What this task downloaded, and what it was refused. */
  'webAssist.downloads': async (
    payload: { conversation_id?: unknown },
    ctx: WebAssistIpcContext,
  ) => webAssistDownloads(
    ctx.userId,
    typeof payload?.conversation_id === 'string' ? payload.conversation_id : '',
  ),

  /** The user's answer to a refused download. Granted outside the transfer,
   *  because a download cannot be held for a dialog; the page retries. */
  'webAssist.allowDownloadOrigin': async (
    payload: { conversation_id?: unknown; origin?: unknown },
    ctx: WebAssistIpcContext,
  ) => allowWebAssistDownloadOrigin(
    ctx.userId,
    typeof payload?.conversation_id === 'string' ? payload.conversation_id : '',
    payload?.origin,
  ),

  /** Renderer answer to one protected page action handback. Shape-only
   *  validation; which handbacks are answerable lives in
   *  features/web_assist_confirm.ts. */
  'webAssist.actionConfirmResponse': async (payload: { request_id?: unknown; decision?: unknown }) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    if (payload?.decision !== 'deny' && payload?.decision !== 'once' && payload?.decision !== 'run') {
      throw new Error('invalid decision');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const confirm = require('../features/web_assist_confirm') as typeof import('../features/web_assist_confirm');
    return { handled: confirm.respond(payload.request_id, payload.decision) };
  },
};
