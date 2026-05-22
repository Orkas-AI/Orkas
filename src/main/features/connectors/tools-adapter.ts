/**
 * Connector visibility resolver + MCP-result stringifier.
 *
 * Until 2026-05 this file built one `AgentTool` per connector × tool and dumped the lot into the
 * AgentRunner's `tools[]`. That hit a hard wall once users started installing 5+ connectors —
 * the model's tool-selection accuracy drops sharply past 20–50 tools (Anthropic 30–50 / Cline
 * ~20 / Cursor ~40), and connect/disconnect events invalidated the entire prompt-cache prefix.
 *
 * Connectors are now surfaced through the three umbrella meta-tools in
 * `model/core-agent/connector-meta-tools.ts` (`list_connectors` / `list_connector_tools` /
 * `call_connector_tool`). The meta-tools share `resolveVisibleConnectors` here so the actor
 * visibility matrix (commander vs. agent worker, `enabled_connectors` whitelist,
 * `enabled_subtools` instance filter) is single-sourced.
 *
 * Actor scope:
 *   - `agentId === undefined` (commander) → every installed instance
 *   - `agentId` present → respect `agent.enabled_connectors`. `undefined` AND `[]` BOTH mean
 *     "no connectors" (intentionally stricter than `agent.skill_list`'s three-state — see
 *     PC/CLAUDE.md §6.5 "Per-agent scope"). Only a non-empty `string[]` grants access.
 *
 * Disconnected instances are still returned (with their stale `tools_cache` and current status)
 * so callers can surface the situation to the user; `manager.callTool` auto-reconnects on use,
 * but `list_connector_tools` refuses to advertise schemas for a non-`connected` instance.
 */
import * as manager from './manager';
import * as agents from '../agents';
import type { ConnectorInstance, ToolSchema } from './types';

/** Convert MCP `callTool`'s raw result into a single string the LLM can read.
 *  MCP result shape: `{ content: [{type, text|data, …}], isError? }`. Text parts are flattened;
 *  anything else is JSON-serialised so the LLM still sees structure. Image / resource parts are
 *  dropped (no multimodal in tool results yet — see plan §10 in connectors.md). */
export function stringifyMcpResult(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const obj = raw as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(obj.content)) {
      const textParts = obj.content
        .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string);
      if (textParts.length) return textParts.join('\n');
    }
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  return String(raw);
}

/** Resolve the connectors visible to a given actor + the tool subset each one exposes.
 *  Returns one entry per visible instance; `tools` is post-`enabled_subtools` filter. Instances
 *  whose `tools_cache` is empty (e.g. cold-start before the first successful list_tools) are
 *  still returned with `tools: []`. */
export async function resolveVisibleConnectors(
  uid: string,
  agentId: string | undefined,
): Promise<Array<{ instance: ConnectorInstance; tools: ToolSchema[] }>> {
  if (!uid) return [];
  const all = manager.listInstances(uid);
  if (!all.length) return [];
  const scope = await _enabledInstancesForActor(uid, agentId, all);
  return scope.map((instance) => {
    const allowed = instance.enabled_subtools;
    const tools = allowed === null
      ? instance.tools_cache
      : instance.tools_cache.filter((t) => allowed.includes(t.name));
    return { instance, tools };
  });
}

async function _enabledInstancesForActor(
  uid: string,
  agentId: string | undefined,
  allInstances: ConnectorInstance[],
): Promise<ConnectorInstance[]> {
  if (!agentId) return allInstances;
  const agent = await agents.getAgent(agentId);
  const allowed = agent?.enabled_connectors;
  if (!Array.isArray(allowed) || allowed.length === 0) return [];
  const allowSet = new Set(allowed);
  return allInstances.filter((i) => allowSet.has(i.id));
}
