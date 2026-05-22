/**
 * Connector umbrella meta-tools + system-prompt block.
 *
 * Replaces the old "flat-inject every connected MCP tool into tools[]" pattern. Motivation is
 * scale: at 30–50 tools the model's selection accuracy drops sharply (Anthropic 30–50 / Cline
 * ~20 / Cursor ~40 / Copilot 128 hard-cap with degradation well below); flat injection also
 * means every connect/disconnect rewrites `tools` and invalidates the entire Anthropic prompt-
 * cache prefix (`tools → system → messages`).
 *
 * Architecture:
 *   1. The list of connected (and visible) connectors is rendered as a `## Connectors` markdown
 *      block injected into the system prompt — `getConnectorPromptBlock`. The block is stable
 *      per session and lives in the cached prefix; the model sees the names + descriptions
 *      without a discovery round-trip.
 *   2. Two meta-tools enable lazy disclosure of each connector's per-action schema:
 *        list_connector_tools(connector_id)        → MCP tool schemas for one connector
 *        call_connector_tool(connector_id, …)      → route to manager.callTool
 *   3. When NO connector is visible to this actor, both the prompt block and the meta-tools are
 *      omitted entirely — `tools[]` shrinks by two slots and the system prompt stays smaller.
 *
 * Visibility: commander sees every connected instance; agent worker is gated by
 * `agent.enabled_connectors` (intentionally stricter than `agent.skill_list` — see
 * PC/CLAUDE.md §6.5). The `enabled_subtools` instance-level whitelist further filters which
 * actions each connector advertises. The two meta-tools share `resolveVisibleConnectors` so the
 * matrix is single-sourced.
 *
 * Session-kind gate: callers (runner.ts) only invoke this module for `gconv` + `gmember`
 * sessions. Edit chats / KB-image extraction / CLI dispatch / reflect / memory-extract / anon
 * don't run user tasks against external services and stay free of connector exposure.
 */
import type { AgentTool, ToolResult } from '#core-agent';

import * as manager from '../../features/connectors/manager';
import {
  resolveVisibleConnectors,
  stringifyMcpResult,
} from '../../features/connectors/tools-adapter';
import { findCatalogEntry } from '../../features/connectors/catalog';
import { getCurrentLang } from '../../i18n';
import { createLogger } from '../../logger';
import type { ConnectorInstance, ToolSchema } from '../../features/connectors/types';

const log = createLogger('connector-meta-tools');

export interface ConnectorMetaToolsOpts {
  /** Active uid. Required — without it the meta-tools have no scope. */
  userId: string;
  /** Agent id when running as an agent worker. Empty / undefined = commander scope (no
   *  `enabled_connectors` filter). */
  agentId?: string;
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

/** Status suffix appended to a connector line. Empty for the healthy `connected` case (most
 *  connectors most of the time) — keeps each line short. Non-empty for states the model needs
 *  to surface to the user. */
function _statusSuffix(status: ConnectorInstance['status']): string {
  switch (status.kind) {
    case 'connected':    return '';
    case 'connecting':   return ' — connecting';
    case 'disconnected': return ' — disconnected (ask user to refresh)';
    case 'error':        return ` — error: ${status.message}`;
    default:             return ` — ${(status as { kind: string }).kind}`;
  }
}

function _renderConnectorLine(instance: ConnectorInstance): string {
  // Catalog entry holds the bilingual description; instance.id doubles as the catalog id (per
  // types.ts: instance.id is the catalog entry id, used both for routing and as the
  // `<id>__<tool>` prefix). Falls back to display_name alone when the catalog has no
  // description (shouldn't happen for shipped connectors).
  const catalog = findCatalogEntry(instance.id);
  const lang = getCurrentLang();
  const desc = catalog
    ? (lang === 'zh' ? catalog.description_zh : catalog.description_en)
    : '';
  const acct = instance.oauth_grant?.account_label ? ` (account: ${instance.oauth_grant.account_label})` : '';
  const head = desc
    ? `**${instance.id}** — ${instance.display_name}: ${desc}${acct}`
    : `**${instance.id}** — ${instance.display_name}${acct}`;
  return `- ${head}${_statusSuffix(instance.status)}`;
}

/** Render the `## Connectors` system-prompt block — pure enumeration (one line per connector).
 *  Returns `''` when nothing is visible; the caller skips concatenation in that case. The block
 *  is stable per session (only changes on connect / disconnect events) so it sits in the cached
 *  prompt prefix. The protocol for invoking connectors via the meta-tools is taught in the
 *  per-role chat prompts (`chat_commander.md` / `chat_agent_in_group.md`); the agent-edit
 *  prompt teaches the "reference connectors by id in the workflow" usage. Keeping the
 *  protocol out of the block lets each role frame its own use without duplication. */
export async function getConnectorPromptBlock(uid: string, agentId: string | undefined): Promise<string> {
  if (!uid) return '';
  const visible = await resolveVisibleConnectors(uid, agentId);
  if (!visible.length) return '';
  const lines: string[] = ['## Connectors', ''];
  for (const { instance } of visible) lines.push(_renderConnectorLine(instance));
  return lines.join('\n');
}

function createListConnectorToolsTool(opts: ConnectorMetaToolsOpts): AgentTool {
  return {
    name: 'list_connector_tools',
    description:
      'Discover the actions available on a specific connector (the system prompt\'s `## Connectors` ' +
      'block lists which connector ids exist for this conversation). Returns each action\'s name, ' +
      'description, and JSON input schema — use the schema verbatim to construct the `args` for ' +
      '`call_connector_tool`. Errors when the connector id is not visible to this actor or is ' +
      'currently disconnected.',
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: {
          type: 'string',
          description: 'The connector id from the `## Connectors` system-prompt block.',
        },
      },
      required: ['connector_id'],
    },
    async execute(input) {
      const cid = typeof (input as { connector_id?: unknown }).connector_id === 'string'
        ? ((input as { connector_id: string }).connector_id).trim()
        : '';
      if (!cid) return errResult('E_BAD_INPUT', '`connector_id` is required (a non-empty string)');

      const visible = await resolveVisibleConnectors(opts.userId, opts.agentId);
      const match = visible.find((v) => v.instance.id === cid);
      if (!match) {
        return errResult(
          'E_CONNECTOR_NOT_VISIBLE',
          `connector "${cid}" is not enabled for this conversation. See the \`## Connectors\` system-prompt block for valid ids.`,
        );
      }
      if (match.instance.status.kind !== 'connected') {
        return errResult(
          'E_CONNECTOR_NOT_CONNECTED',
          `connector "${cid}" is currently ${match.instance.status.kind}. ` +
          'Tell the user to open the Connectors panel and click "刷新工具" / "Refresh tools".',
        );
      }
      if (!match.tools.length) {
        return {
          content: `Connector "${cid}" reports no actions. Ask the user to refresh it from the Connectors panel.`,
        };
      }

      const lines: string[] = [
        `Actions on connector "${cid}". Invoke any of them via ` +
        `\`call_connector_tool({connector_id: "${cid}", tool_name: "<name>", args: {…}})\` — ` +
        '`args` MUST match the listed input_schema verbatim.',
        '',
      ];
      for (const t of match.tools) {
        lines.push(`### ${t.name}`);
        lines.push(t.description || '(no description)');
        lines.push('');
        lines.push('Input schema:');
        lines.push('```json');
        try {
          lines.push(JSON.stringify(t.input_schema ?? {}, null, 2));
        } catch {
          lines.push('{}');
        }
        lines.push('```');
        lines.push('');
      }
      return { content: lines.join('\n').trimEnd() };
    },
  };
}

function createCallConnectorToolTool(opts: ConnectorMetaToolsOpts): AgentTool {
  return {
    name: 'call_connector_tool',
    description:
      'Invoke a specific action on a connected third-party service. Always call ' +
      '`list_connector_tools(connector_id)` first (in this conversation) to learn the action ' +
      'name and its input schema; then construct `args` to match that schema. The result is ' +
      'the connector\'s response (text / JSON), exactly as the underlying service returned it.',
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: {
          type: 'string',
          description: 'The connector id from the `## Connectors` system-prompt block.',
        },
        tool_name: {
          type: 'string',
          description: 'The action name from `list_connector_tools`.',
        },
        args: {
          type: 'object',
          description: 'Arguments matching the action\'s `input_schema`. Must be a JSON object.',
        },
      },
      required: ['connector_id', 'tool_name', 'args'],
    },
    async execute(input) {
      const i = input as { connector_id?: unknown; tool_name?: unknown; args?: unknown };
      const cid = typeof i.connector_id === 'string' ? i.connector_id.trim() : '';
      const toolName = typeof i.tool_name === 'string' ? i.tool_name.trim() : '';
      if (!cid || !toolName) {
        return errResult('E_BAD_INPUT', '`connector_id` and `tool_name` are both required non-empty strings');
      }
      // Accept both `args: {}` and `args: "{}"`. Models routinely stringify nested JSON when the
      // outer call already serializes through JSON — re-parsing here keeps the meta-tool ergonomic
      // and avoids retry loops where the model just sends the same shape again (we saw GitHub
      // get_me hit this twice in a row before the parse fallback). Reject only when the input is
      // neither a JSON object nor a string that parses to one.
      let args: Record<string, unknown> | null = null;
      if (i.args && typeof i.args === 'object' && !Array.isArray(i.args)) {
        args = i.args as Record<string, unknown>;
      } else if (typeof i.args === 'string') {
        const s = i.args.trim();
        if (s === '' || s === '{}') {
          args = {};
        } else {
          try {
            const parsed: unknown = JSON.parse(s);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch { /* fall through to error below */ }
        }
      }
      if (args === null) {
        return errResult('E_BAD_INPUT', '`args` is required and must be a JSON object (use {} for no-arg actions)');
      }

      const visible = await resolveVisibleConnectors(opts.userId, opts.agentId);
      const match = visible.find((v) => v.instance.id === cid);
      if (!match) {
        return errResult(
          'E_CONNECTOR_NOT_VISIBLE',
          `connector "${cid}" is not enabled for this conversation. See the \`## Connectors\` system-prompt block for valid ids.`,
        );
      }
      const toolMatch = match.tools.find((t) => t.name === toolName);
      if (!toolMatch) {
        return errResult(
          'E_TOOL_NOT_AVAILABLE',
          `action "${toolName}" is not available on connector "${cid}". ` +
          `Call list_connector_tools({connector_id: "${cid}"}) to see the actual action names.`,
        );
      }

      try {
        const raw = await manager.callTool(opts.userId, cid, toolName, args);
        return { content: stringifyMcpResult(raw) };
      } catch (err) {
        const msg = (err as Error).message;
        log.warn(`call_connector_tool failed connector=${cid} tool=${toolName}: ${msg}`);
        return {
          content: `Error calling ${cid}/${toolName}: ${msg}`,
          isError: true,
        };
      }
    },
  };
}

/** Build the connector meta-tools for a single runner. Returns `[]` when uid is empty OR when
 *  the actor has no visible connectors — in that case the system prompt also doesn't carry the
 *  `## Connectors` block, so the tools have nothing to act on and would only confuse the model. */
export async function createConnectorMetaTools(opts: ConnectorMetaToolsOpts): Promise<AgentTool[]> {
  if (!opts.userId) return [];
  const visible = await resolveVisibleConnectors(opts.userId, opts.agentId);
  if (!visible.length) return [];
  return [
    createListConnectorToolsTool(opts),
    createCallConnectorToolTool(opts),
  ];
}
