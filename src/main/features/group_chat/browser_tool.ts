/**
 * Model contract for the shared, visible Browser tab in Task Details.
 *
 * The Electron/WebContentsView runtime remains in features/web_assist. This
 * module owns only the provider-visible schema, cross-field validation, and a
 * narrow callback boundary so Commander and in-process named Agents share the
 * same host-bound tool with external CLI Agents.
 */

import type { AgentTool } from '#core-agent';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { browserTaskRunId } from '../web_assist_lifecycle';

const contract = require('../../../../bin/browser-tool-contract.cjs');
const schema = z.object(contract.shape(z)).strict();
const { $schema: _schemaVersion, ...inputSchema } = zodToJsonSchema(schema);

export interface BrowserToolCallbacks {
  tabs: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  open: (input: { url: string; label?: string }) => Promise<Record<string, unknown>>;
  navigate: (input: {
    tabId?: string;
    action: 'goto' | 'back' | 'forward' | 'reload';
    url?: string;
  }) => Promise<Record<string, unknown>>;
  observe: (tabId?: string) => Promise<Record<string, unknown>>;
  act: (input: {
    tabId?: string;
    pageId: string;
    elementRef?: string;
    action: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'scroll';
    text?: string;
    direction?: 'up' | 'down' | 'top' | 'bottom';
  }) => Promise<Record<string, unknown>>;
  wait: (input: {
    tabId?: string;
    condition: 'loaded' | 'text';
    text?: string;
    timeoutMs?: number;
  }) => Promise<Record<string, unknown>>;
  close: (tabId: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  retain: (tabId: string, retention: 'deliverable' | 'handoff' | 'temporary') => Promise<Record<string, unknown>> | Record<string, unknown>;
}

function output(data: Record<string, unknown>): { content: string; isError?: true } {
  return {
    content: JSON.stringify(data),
    ...(data.ok === false ? { isError: true as const } : {}),
  };
}

function error(message: string): { content: string; isError: true } {
  return output({ ok: false, error: message }) as { content: string; isError: true };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const OPERATIONS = new Set(['tabs', 'open', 'navigate', 'observe', 'act', 'wait', 'close', 'retain']);
const NAVIGATION_ACTIONS = new Set(['goto', 'back', 'forward', 'reload']);
const PAGE_ACTIONS = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'scroll']);
const DIRECTIONS = new Set(['up', 'down', 'top', 'bottom']);

export function buildBrowserTool(callbacks: BrowserToolCallbacks): AgentTool {
  return {
    name: 'browser',
    description: contract.description,
    inputSchema: inputSchema as AgentTool['inputSchema'],
    async execute(input) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return error(parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      const operation = String(input.operation || '').trim();
      if (!OPERATIONS.has(operation)) return error('unsupported browser operation');
      const tabId = optionalString(input.tab_id);
      if (tabId && !/^[0-9a-f]{12}$/u.test(tabId)) return error('`tab_id` is invalid');
      try {
        if (operation === 'tabs') return output(await callbacks.tabs());
        if (operation === 'open') {
          const url = optionalString(input.url);
          if (!url) return error('`url` is required for open');
          const label = optionalString(input.label);
          if (url.length > 2048) return error('`url` must be at most 2048 characters');
          if (label && label.length > 120) return error('`label` must be at most 120 characters');
          return output(await callbacks.open({ url, ...(label ? { label } : {}) }));
        }
        if (operation === 'navigate') {
          const navigation = String(input.navigation || '').trim();
          if (!NAVIGATION_ACTIONS.has(navigation)) return error('`navigation` is required for navigate');
          const url = optionalString(input.url);
          if (navigation === 'goto' && !url) return error('`url` is required for navigate goto');
          if (url && url.length > 2048) return error('`url` must be at most 2048 characters');
          return output(await callbacks.navigate({
            ...(tabId ? { tabId } : {}),
            action: navigation as 'goto' | 'back' | 'forward' | 'reload',
            ...(url ? { url } : {}),
          }));
        }
        if (operation === 'observe') return output(await callbacks.observe(tabId));
        if (operation === 'act') {
          const pageId = optionalString(input.page_id);
          const pageAction = String(input.page_action || '').trim();
          if (!pageId) return error('`page_id` is required for act');
          if (pageId.length > 64) return error('`page_id` must be at most 64 characters');
          if (!PAGE_ACTIONS.has(pageAction)) return error('`page_action` is required for act');
          const elementRef = optionalString(input.element_ref);
          if (pageAction !== 'scroll' && !elementRef) {
            return error('`element_ref` is required for this page action');
          }
          if (elementRef && !/^e[1-9][0-9]*$/u.test(elementRef)) return error('`element_ref` is invalid');
          if ((pageAction === 'fill' || pageAction === 'select') && typeof input.text !== 'string') {
            return error(`\`text\` is required for ${pageAction}`);
          }
          if (typeof input.text === 'string' && input.text.length > 2000) {
            return error('`text` must be at most 2000 characters');
          }
          const direction = optionalString(input.direction);
          if (direction && !DIRECTIONS.has(direction)) return error('unsupported scroll direction');
          return output(await callbacks.act({
            ...(tabId ? { tabId } : {}),
            pageId,
            ...(elementRef ? { elementRef } : {}),
            action: pageAction as 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'scroll',
            ...(typeof input.text === 'string' ? { text: input.text } : {}),
            ...(direction ? { direction: direction as 'up' | 'down' | 'top' | 'bottom' } : {}),
          }));
        }
        if (operation === 'wait') {
          const condition = String(input.wait_condition || 'loaded').trim();
          if (condition !== 'loaded' && condition !== 'text') return error('unsupported wait condition');
          const text = optionalString(input.text);
          if (condition === 'text' && !text) return error('`text` is required for wait text');
          if (condition === 'text' && text!.length > 240) return error('wait `text` must be at most 240 characters');
          const timeout = input.timeout_ms === undefined ? undefined : Number(input.timeout_ms);
          if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 250 || timeout > 15_000)) {
            return error('`timeout_ms` must be an integer from 250 to 15000');
          }
          return output(await callbacks.wait({
            ...(tabId ? { tabId } : {}),
            condition,
            ...(text ? { text } : {}),
            ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
          }));
        }
        if (!tabId) return error(`\`tab_id\` is required for ${operation}`);
        if (operation === 'retain') {
          if (input.retention !== 'deliverable' && input.retention !== 'handoff' && input.retention !== 'temporary') {
            return error('`retention` must be deliverable, handoff or temporary');
          }
          return output(await callbacks.retain(tabId, input.retention));
        }
        return output(await callbacks.close(tabId));
      } catch {
        return error('The task browser operation failed');
      }
    },
  };
}

export function buildConversationBrowserTool(uid: string, cid: string, isActive: () => boolean = () => true): AgentTool {
  const runId = browserTaskRunId(uid, cid);
  async function withBrowser(
    run: (web: typeof import('../web_assist')) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const ended = () => !isActive() || !runId || browserTaskRunId(uid, cid) !== runId;
    const endedResult = { ok: false, code: 'task_run_ended', error: 'This browser task turn has ended.' };
    if (ended()) return endedResult;
    const web = await import('../web_assist');
    if (ended()) return endedResult;
    return run(web);
  }
  return buildBrowserTool({
    tabs: () => withBrowser(web => web.listModelWebAssistTabs(uid, cid)),
    open: input => withBrowser(web => web.openModelWebAssist(uid, cid, input)),
    navigate: input => withBrowser(web => web.navigateModelWebAssist(uid, cid, input)),
    observe: tabId => withBrowser(web => web.observeModelWebAssist(uid, cid, tabId)),
    act: input => withBrowser(web => web.actOnModelWebAssist(uid, cid, input)),
    wait: input => withBrowser(web => web.waitForModelWebAssist(uid, cid, input)),
    close: tabId => withBrowser(web => web.closeModelWebAssistTab(uid, cid, tabId)),
    retain: (tabId, retention) => withBrowser(web => web.retainModelWebAssistTab(uid, cid, tabId, retention)),
  });
}
