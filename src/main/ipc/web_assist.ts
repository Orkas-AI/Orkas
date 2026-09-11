/** Renderer-only IPC adapter for the platform Web Assist component. */

import type { WebContents } from 'electron';

import {
  activateWebAssistTab,
  addWebAssistTab,
  closeWebAssistTab,
  closeWebAssist,
  layoutWebAssist,
  navigateWebAssist,
  navigateWebAssistTo,
  openWebAssist,
  openWebAssistInDefaultBrowser,
  setActiveWebAssistConversation,
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

  'webAssist.navigate': async (
    payload: { action?: unknown },
    ctx: WebAssistIpcContext,
  ) => navigateWebAssist(ctx.sender, payload?.action),

  'webAssist.openExternal': async (_payload: unknown, ctx: WebAssistIpcContext) => (
    openWebAssistInDefaultBrowser(ctx.sender)
  ),

  'webAssist.close': async (_payload: unknown, ctx: WebAssistIpcContext) => closeWebAssist(ctx.sender),

  'webAssist.state': async (_payload: unknown, ctx: WebAssistIpcContext) => webAssistState(ctx.sender),
};
