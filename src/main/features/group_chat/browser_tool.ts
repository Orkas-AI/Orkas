/**
 * Model contract for the shared, visible Browser tab in Task Details.
 *
 * The Electron/WebContentsView runtime remains in features/web_assist. This
 * module owns only the provider-visible schema, cross-field validation, and a
 * narrow callback boundary so Commander and in-process named Agents share the
 * same host-bound tool with external CLI Agents.
 */

import type { AgentTool, ToolResult } from '#core-agent';
import { z } from 'zod';
const { schemaToJson } = require('../../../../bin/schema-to-json.cjs');
import { createLogger } from '../../logger';
import { withRetrievalBudget } from '../../util/tool-result-cap';
import { browserTaskRunId, type BrowserTabRetention } from '../web_assist_lifecycle';

const log = createLogger('browser-tool');
const contract = require('../../../../bin/browser-tool-contract.cjs');
const schema = z.object(contract.shape(z)).strict();
const { $schema: _schemaVersion, ...inputSchema } = schemaToJson(schema);

export interface BrowserToolCallbacks {
  tabs: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  open: (input: { url: string; label?: string; retention?: BrowserTabRetention }) => Promise<Record<string, unknown>>;
  navigate: (input: {
    tabId?: string;
    action: 'goto' | 'back' | 'forward' | 'reload';
    url?: string;
  }) => Promise<Record<string, unknown>>;
  observe: (
    tabId?: string,
    scope?: 'full' | 'meta',
    window?: { textOffset?: number; elementOffset?: number; frameId?: string; tokenBudget?: number },
  ) => Promise<Record<string, unknown>>;
  readValue: (input: { tabId?: string; pageId: string; elementRef: string; textOffset: number; action?: 'read_value' | 'options'; optionOffset?: number }, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  act: (input: {
    tabId?: string;
    pageId: string;
    elementRef?: string;
    point?: number[];
    action: import('../web_assist_page').WebAssistPageAction;
    values?: string[];
    keys?: string;
    filePaths?: string[];
    text?: string;
    dragDeltaX?: number;
    dragDeltaY?: number;
    direction?: 'up' | 'down' | 'top' | 'bottom' | 'left' | 'right';
  }, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  screenshot?: (input: { tabId?: string; frameId?: string; clip?: number[] }, signal?: AbortSignal) => Promise<ToolResult>;
  chooseFiles?: (directory: boolean, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  wait: (input: {
    tabId?: string;
    condition: 'loaded' | 'text';
    text?: string;
    timeoutMs?: number;
  }, signal?: AbortSignal) => Promise<Record<string, unknown>>;
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

const OPERATIONS = new Set(['tabs', 'open', 'navigate', 'observe', 'read_value', 'options', 'screenshot', 'choose_files', 'act', 'wait', 'close', 'retain']);
const NAVIGATION_ACTIONS = new Set(['goto', 'back', 'forward', 'reload']);
const PAGE_ACTIONS = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'scroll', 'drag', 'upload', 'press', 'hover', 'double_click', 'right_click']);
const DIRECTIONS = new Set(['up', 'down', 'top', 'bottom', 'left', 'right']);
const OBSERVE_SCOPES = new Set(['full', 'meta']);

export function buildBrowserTool(callbacks: BrowserToolCallbacks): AgentTool {
  return {
    name: 'inner_browser',
    description: contract.description,
    inputSchema: inputSchema as AgentTool['inputSchema'],
    async execute(input, context) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return error(parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      input = parsed.data;
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
          if (label && label.length > 120) return error('`label` must be at most 120 characters');
          return output(await callbacks.open({ url, ...(label ? { label } : {}),
            ...(input.retention ? { retention: input.retention as BrowserTabRetention } : {}),
          }));
        }
        if (operation === 'navigate') {
          const navigation = String(input.navigation || '').trim();
          if (!NAVIGATION_ACTIONS.has(navigation)) return error('`navigation` is required for navigate');
          const url = optionalString(input.url);
          if (navigation === 'goto' && !url) return error('`url` is required for navigate goto');
          return output(await callbacks.navigate({
            ...(tabId ? { tabId } : {}),
            action: navigation as 'goto' | 'back' | 'forward' | 'reload',
            ...(url ? { url } : {}),
          }));
        }
        if (operation === 'screenshot') {
          if (!callbacks.screenshot) return error('Screenshots are unavailable');
          return callbacks.screenshot({ ...(tabId ? { tabId } : {}), ...(input.frame_id ? { frameId: String(input.frame_id) } : {}), ...(input.clip ? { clip: input.clip as number[] } : {}) }, context?.signal);
        }
        if (operation === 'choose_files') {
          if (!callbacks.chooseFiles) return error('File selection is unavailable');
          return output(await callbacks.chooseFiles(input.directory === true, context?.signal));
        }
        if (operation === 'observe') {
          const scope = optionalString(input.scope) || 'full';
          if (!OBSERVE_SCOPES.has(scope)) return error('`scope` must be full or meta');
          const offsets: { textOffset?: number; elementOffset?: number; frameId?: string; tokenBudget?: number } = {
            ...(input.frame_id ? { frameId: String(input.frame_id) } : {}),
            // A full page is sized like a read_files page so it stays inline
            // with its element refs instead of spilling to a preview.
          };
          for (const [key, field] of [['text_offset', 'textOffset'], ['element_offset', 'elementOffset']] as const) {
            if (input[key] === undefined) continue;
            const parsed = Number(input[key]);
            if (!Number.isInteger(parsed) || parsed < 0) {
              return error(`\`${key}\` must be a non-negative integer`);
            }
            offsets[field] = parsed;
          }
          if (scope === 'full') {
            return await withRetrievalBudget({ ...context, state: context?.state ?? {} }, async (_ctx, budget) =>
              output(await callbacks.observe(tabId, 'full', { ...offsets, tokenBudget: budget })));
          }
          return output(await callbacks.observe(tabId, 'meta', offsets));
        }
        if (operation === 'read_value' || operation === 'options') {
          const pageId = optionalString(input.page_id);
          const elementRef = optionalString(input.element_ref);
          if (!pageId || !elementRef) return error('`page_id` and `element_ref` are required for read_value');
          return output(await callbacks.readValue({ ...(tabId ? { tabId } : {}), pageId, elementRef,
            textOffset: input.text_offset === undefined ? 0 : Number(input.text_offset), ...(operation === 'options' ? { action: 'options' as const, optionOffset: Number(input.option_offset || 0) } : {}) }, context?.signal));
        }
        if (operation === 'act') {
          const pageId = optionalString(input.page_id);
          const pageAction = String(input.page_action || '').trim();
          if (!pageId) return error('`page_id` is required for act');
          if (pageId.length > 64) return error('`page_id` must be at most 64 characters');
          if (!PAGE_ACTIONS.has(pageAction)) return error('`page_action` is required for act');
          const elementRef = optionalString(input.element_ref);
          if (input.point && (elementRef || !['click', 'hover', 'double_click', 'right_click', 'drag'].includes(pageAction))) {
            return error('point replaces element_ref only for click/hover/double_click/right_click/drag');
          }
          if (!['scroll', 'press'].includes(pageAction) && !elementRef && !input.point) {
            return error('`element_ref` is required for this page action');
          }
          if (elementRef && !/^e[1-9][0-9]*$/u.test(elementRef)) return error('`element_ref` is invalid');
          if ((pageAction === 'fill' || (pageAction === 'select' && !Array.isArray(input.values))) && typeof input.text !== 'string') {
            return error(`\`text\` is required for ${pageAction}`);
          }
          if (pageAction === 'press' && typeof input.keys !== 'string') return error('`keys` is required for press');
          if (pageAction === 'upload' && !Array.isArray(input.file_paths)) return error('`file_paths` is required for upload');
          if (typeof input.text === 'string' && input.text.length > contract.MAX_PAGE_ACTION_TEXT_LENGTH) {
            return error(`\`text\` must be at most ${contract.MAX_PAGE_ACTION_TEXT_LENGTH} characters`);
          }
          if (pageAction === 'drag' && (typeof input.drag_delta_x !== 'number' || typeof input.drag_delta_y !== 'number'
              || (input.drag_delta_x === 0 && input.drag_delta_y === 0))) return error('drag requires nonzero movement and both drag_delta_x and drag_delta_y');
          const direction = optionalString(input.direction);
          if (direction && !DIRECTIONS.has(direction)) return error('unsupported scroll direction');
          return output(await callbacks.act({
            ...(tabId ? { tabId } : {}),
            pageId,
            ...(elementRef ? { elementRef } : {}),
            ...(input.point ? { point: input.point as number[] } : {}),
            ...(pageAction === 'drag' ? { dragDeltaX: Number(input.drag_delta_x), dragDeltaY: Number(input.drag_delta_y) } : {}),
            action: pageAction as import('../web_assist_page').WebAssistPageAction,
            ...(Array.isArray(input.values) ? { values: input.values as string[] } : {}),
            ...(typeof input.keys === 'string' ? { keys: input.keys } : {}),
            ...(pageAction === 'upload' ? { filePaths: input.file_paths as string[] } : {}),
            ...(typeof input.text === 'string' ? { text: input.text } : {}),
            ...(direction ? { direction: direction as 'up' | 'down' | 'top' | 'bottom' | 'left' | 'right' } : {}),
          }, context?.signal));
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
          }, context?.signal));
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
        log.warn('browser operation failed', { operation });
        return error('The task browser operation failed');
      }
    },
  };
}

export function buildConversationBrowserTool(uid: string, cid: string, isActive: () => boolean = () => true): AgentTool {
  const runId = browserTaskRunId(uid, cid);
  const ended = () => !isActive() || !runId || browserTaskRunId(uid, cid) !== runId;
  async function withBrowser(
    run: (web: typeof import('../web_assist')) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
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
    observe: (tabId, scope, window) => withBrowser(web => web.observeModelWebAssist(uid, cid, tabId, scope, window)),
    screenshot: async (input, signal) => {
      if (ended()) return output({ ok: false, code: 'task_run_ended' });
      const web = await import('../web_assist');
      if (ended()) return output({ ok: false, code: 'task_run_ended' });
      return web.screenshotModelWebAssist(uid, cid, input, { signal, isActive: () => !ended() });
    },
    chooseFiles: (directory, signal) => withBrowser(web => web.chooseModelWebAssistFiles(uid, cid, directory, { signal, isActive: () => !ended() })),
    readValue: (input, signal) => withBrowser(web => web.readModelWebAssistValue(uid, cid, input, {
      signal, isActive: () => !ended(),
    })),
    act: (input, signal) => withBrowser(web => web.actOnModelWebAssist(uid, cid, input, {
      signal, isActive: () => !ended(),
    })),
    wait: (input, signal) => withBrowser(web => web.waitForModelWebAssist(uid, cid, input, {
      signal, isActive: () => !ended(),
    })),
    close: tabId => withBrowser(web => web.closeModelWebAssistTab(uid, cid, tabId)),
    retain: (tabId, retention) => withBrowser(web => web.retainModelWebAssistTab(uid, cid, tabId, retention)),
  });
}
