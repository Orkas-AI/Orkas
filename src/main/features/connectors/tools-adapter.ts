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
import { isConnectorEnabled } from '../component_enabled';
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
 *  still returned with `tools: []`.
 *
 *  Google Workspace overlap: the all-in-one `google-workspace` connector intentionally coexists
 *  with the five single-service connectors. When both are visible to the current actor, the
 *  single-service connector wins for its service and the duplicate Workspace tools are hidden.
 *  This keeps the model from seeing two Gmail/Calendar/etc. routes for the same action while
 *  still letting Workspace provide any services the user did not connect separately. */
export async function resolveVisibleConnectors(
  uid: string,
  agentId: string | undefined,
): Promise<Array<{ instance: ConnectorInstance; tools: ToolSchema[] }>> {
  if (!uid) return [];
  const all = manager.listInstances(uid);
  if (!all.length) return [];
  // Live-state filter: only currently-connected instances surface to the LLM. A `connecting` /
  // `disconnected` / `error` instance is unreachable in this turn — `manager.callTool` would
  // throw anyway, and showing it (with a "— disconnected (ask user to refresh)" suffix) is
  // noise that pollutes both the prompt block and the meta-tool routing matrix. The user can
  // reconnect in the Connectors panel; the instance reappears on the next turn.
  const connected = all.filter((i) => i.status.kind === 'connected');
  if (!connected.length) return [];
  // Per-user soft-disable filter (Connectors panel "停用" button). Separate from `agent.enabled_connectors`:
  // this filter applies to every actor including the commander; even a disconnected-by-user instance
  // that's still OAuth-grant-valid and MCP-connected stays hidden from the LLM until re-enabled.
  // See features/component_enabled.ts + CLAUDE.md §6.5 "Per-user enable toggle".
  const userEnabled = connected.filter((i) => isConnectorEnabled(uid, i.id));
  if (!userEnabled.length) return [];
  const scope = await _enabledInstancesForActor(uid, agentId, userEnabled);
  const resolved = scope.map((instance) => {
    const allowed = instance.enabled_subtools;
    const tools = allowed === null
      ? instance.tools_cache
      : instance.tools_cache.filter((t) => allowed.includes(t.name));
    return { instance, tools };
  });
  return _dedupeGoogleWorkspaceTools(resolved);
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

const GOOGLE_WORKSPACE_ID = 'google-workspace';
type GoogleWorkspaceService = 'gmail' | 'gcal' | 'gdocs' | 'gsheets' | 'gtasks';

const GOOGLE_SERVICE_BY_CONNECTOR_ID: Record<string, GoogleWorkspaceService> = {
  gmail: 'gmail',
  gcal: 'gcal',
  gdocs: 'gdocs',
  gsheets: 'gsheets',
  gtasks: 'gtasks',
};

function _dedupeGoogleWorkspaceTools(
  visible: Array<{ instance: ConnectorInstance; tools: ToolSchema[] }>,
): Array<{ instance: ConnectorInstance; tools: ToolSchema[] }> {
  const workspace = visible.find((v) => v.instance.id === GOOGLE_WORKSPACE_ID);
  if (!workspace) return visible;

  // Collect tool names from every visible single-Google-service connector.
  // `bin/google-workspace-mcp-server.cjs` wraps the same five service
  // adapters the standalone connectors use, preserving each adapter's
  // original tool `name` and only adding a `[Gmail]` / `[Calendar]` / …
  // prefix to the `description`. So `name` is the strict equality
  // invariant — a service tool advertised under standalone `gmail`
  // shares its name byte-for-byte with the workspace's wrapped copy.
  // Matching by name is robust to a future UI polish that drops the
  // description prefix (which would silently break the prior
  // description-prefix dedup and re-expose both Gmail routes to the
  // model — the 20–50 tool-selection-accuracy cliff anti-pattern that
  // PC/CLAUDE.md §6.5 warns against).
  const shadowedNames = new Set<string>();
  for (const { instance, tools } of visible) {
    if (instance.id === GOOGLE_WORKSPACE_ID) continue;
    if (!GOOGLE_SERVICE_BY_CONNECTOR_ID[instance.id]) continue;
    for (const t of tools) shadowedNames.add(t.name);
  }
  if (!shadowedNames.size) return visible;

  return visible
    .map((v) => {
      if (v.instance.id !== GOOGLE_WORKSPACE_ID) return v;
      return {
        instance: v.instance,
        tools: v.tools.filter((t) => !shadowedNames.has(t.name)),
      };
    })
    // When all five single-service connectors are visible, the Workspace connector has no unique
    // tools left to expose to the model. Hide that empty duplicate route entirely.
    .filter((v) => v.instance.id !== GOOGLE_WORKSPACE_ID || v.tools.length > 0);
}

/** Test-only export — see `test/main/features/connectors/dedupe-google-workspace.test.ts`. */
export const _dedupeGoogleWorkspaceToolsForTest = _dedupeGoogleWorkspaceTools;
