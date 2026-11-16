/** Renderer-only IPC adapter for the platform Web Assist component. */

import type { WebContents } from 'electron';

import {
  activateWebAssistTab,
  addWebAssistTab,
  closeWebAssistTab,
  closeWebAssist,
  handBackWebAssist,
  resetWebAssistPermissions,
  answerWebAssistPermission,
  answerWebAssistDialog,
  setWebAssistOverlayState,
  layoutWebAssist,
  navigateWebAssist,
  navigateWebAssistTo,
  openWebAssist,
  openWebAssistInDefaultBrowser,
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
    payload: { x?: unknown; y?: unknown; width?: unknown; height?: unknown; visible?: unknown; overlayRevision?: unknown; overlayEpoch?: unknown },
    ctx: WebAssistIpcContext,
  ) => layoutWebAssist(ctx.sender, payload),

  'webAssist.overlayState': async (payload: { blocked?: unknown; revision?: unknown; epoch?: unknown }, ctx: WebAssistIpcContext) => (
    setWebAssistOverlayState(ctx.sender, payload || {})
  ),

  'webAssist.navigate': async (
    payload: { action?: unknown },
    ctx: WebAssistIpcContext,
  ) => navigateWebAssist(ctx.sender, payload?.action),

  'webAssist.openExternal': async (_payload: unknown, ctx: WebAssistIpcContext) => (
    openWebAssistInDefaultBrowser(ctx.sender)
  ),

  'webAssist.close': async (_payload: unknown, ctx: WebAssistIpcContext) => closeWebAssist(ctx.sender),

  'webAssist.resetPermissions': async (payload: { tabId?: unknown }, ctx: WebAssistIpcContext) => resetWebAssistPermissions(ctx.sender, payload?.tabId),

  'webAssist.permissionResponse': async (payload: { tabId?: unknown; requestId?: unknown; allowed?: unknown }, ctx: WebAssistIpcContext) => answerWebAssistPermission(ctx.sender, payload || {}),

  'webAssist.dialogResponse': async (payload: { tabId?: unknown; requestId?: unknown; accepted?: unknown; value?: unknown; editing?: unknown }, ctx: WebAssistIpcContext) => answerWebAssistDialog(ctx.sender, payload || {}),

  'webAssist.handback': async (payload: { tabId?: unknown }, ctx: WebAssistIpcContext) => handBackWebAssist(ctx.sender, payload?.tabId),

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

  // Compatibility for a renderer from before browser page-action gates were removed.
  'webAssist.actionConfirmResponse': async () => ({ handled: false }),
};
