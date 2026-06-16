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
 * Visibility: commander sees every connected instance. The `enabled_subtools` instance-level
 * whitelist further filters which actions each connector advertises. The resolver still accepts
 * an optional actor filter for tests / future gates, but runner.ts no longer exposes connector
 * tools to group-chat agent workers.
 *
 * Session-kind gate: callers (runner.ts) invoke this module for `gconv` full access and
 * `agent` edit-session discovery. Group-chat agent workers / skill edit chats / KB-image
 * extraction / CLI dispatch / reflect / memory-extract / anon stay free of connector exposure.
 */
import type { AgentTool, ToolResult } from '#core-agent';

import * as manager from '../../features/connectors/manager';
import {
  resolveVisibleConnectors,
  stringifyMcpResult,
} from '../../features/connectors/tools-adapter';
import { validateCustomTransport, validateDisplayName, CustomTransportError } from '../../features/connectors/custom-transport';
import { requestInstallConfirm } from '../../features/connectors/install_confirm';
import { findCatalogEntry } from '../../features/connectors/catalog';
import { getLanguageForUser } from '../../features/config';
import { descriptionLang } from '../../i18n';
import { createLogger } from '../../logger';
import type { ConnectorInstance, ToolSchema } from '../../features/connectors/types';

const log = createLogger('connector-meta-tools');

export interface ConnectorMetaToolsOpts {
  /** Active uid. Required — without it the meta-tools have no scope. */
  userId: string;
  /** Optional actor filter. Empty / undefined = commander scope. */
  agentId?: string;
  /** Conversation id — required for the commander `add_custom_connector`
   *  tool so its confirmation dialog routes to the right conversation.
   *  Omitted for discover-mode (agent-edit) where add is not exposed. */
  cid?: string;
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

function _descriptionLangForUser(uid: string): 'zh' | 'en' {
  try {
    return descriptionLang(getLanguageForUser(uid));
  } catch {
    return 'en';
  }
}

function _renderConnectorLine(instance: ConnectorInstance, lang: 'zh' | 'en'): string {
  // Catalog entry holds the bilingual description; instance.id doubles as the catalog id (per
  // types.ts: instance.id is the catalog entry id, used both for routing and as the
  // `<id>__<tool>` prefix). Falls back to display_name alone when the catalog has no
  // description (shouldn't happen for shipped connectors).
  //
  // No status suffix: `resolveVisibleConnectors` filters to `status.kind === 'connected'` so
  // every line is implicitly healthy. Disconnected / errored / connecting instances are hidden
  // from the LLM entirely — see tools-adapter.ts for the filter + rationale.
  const catalog = findCatalogEntry(instance.id);
  const descKey = `description_${lang}` as 'description_zh' | 'description_en';
  const desc = catalog ? (catalog[descKey] || '') : '';
  const acct = instance.oauth_grant?.account_label ? ` (account: ${instance.oauth_grant.account_label})` : '';
  return desc
    ? `- **${instance.id}** — ${instance.display_name}: ${desc}${acct}`
    : `- **${instance.id}** — ${instance.display_name}${acct}`;
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
  const lang = _descriptionLangForUser(uid);
  const lines: string[] = ['## Connectors', ''];
  for (const { instance } of visible) lines.push(_renderConnectorLine(instance, lang));
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
        // resolveVisibleConnectors already filters to `status.kind === 'connected'`, so a miss
        // here means either the id is wrong OR the connector went disconnected between block
        // render and this call. Either way the LLM's recovery is identical (re-read the
        // `## Connectors` block, or ask the user to refresh) — one error code keeps it simple.
        return errResult(
          'E_CONNECTOR_NOT_VISIBLE',
          `connector "${cid}" is not currently available. See the \`## Connectors\` system-prompt block for valid ids; if it was there a moment ago, ask the user to refresh it in the Connectors panel.`,
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

/** Commander-only tool: install a user-described custom MCP server. The
 *  install ALWAYS requires the user to approve a confirmation dialog
 *  (plan §C2 / §C3) — for stdio that dialog shows the exact command that
 *  will run. The LLM can describe the server but cannot complete the
 *  install on its own. Bound to a cid so the confirm dialog routes to the
 *  right conversation. */
function createAddCustomConnectorTool(opts: ConnectorMetaToolsOpts & { cid: string }): AgentTool {
  return {
    name: 'add_custom_connector',
    description:
      'Add a custom MCP server the user described (e.g. pasted from an mcp.json or docs). '
      + 'Use ONLY when the user explicitly wants to connect a specific MCP server that is not in '
      + 'the built-in Connectors list. The user must approve a confirmation dialog before it is '
      + 'installed — for a local command, that dialog shows the exact command that will run, so '
      + 'present what you are about to add in plain terms first. On approval the server is '
      + 'connected and its tools become available via `list_connector_tools` / '
      + '`call_connector_tool` like any other connector.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short display name for the server.' },
        transport: {
          type: 'object',
          description:
            'Either { kind: "streamable-http", url, headers? } for a remote server, or '
            + '{ kind: "stdio", command, args?, env? } for a local command. Put API keys in '
            + 'headers (http) or env (stdio).',
        },
      },
      required: ['name', 'transport'],
    },
    async execute(input) {
      const i = input as { name?: unknown; transport?: unknown };
      let displayName: string;
      let transport;
      try {
        displayName = validateDisplayName(i.name);
        transport = validateCustomTransport(i.transport as never);
      } catch (err) {
        const code = err instanceof CustomTransportError ? err.code : 'E_INVALID';
        return errResult(code, `invalid custom connector: ${(err as Error).message}`);
      }

      const approved = await requestInstallConfirm({ cid: opts.cid, displayName, transport });
      if (!approved) {
        return { content: 'The user declined to add this connector. Do not retry; ask if they want to adjust it.' };
      }
      try {
        const inst = await manager.addCustomInstance(opts.userId, { display_name: displayName, transport });
        if (inst.status.kind === 'connected') {
          return { content: `Connected "${inst.display_name}" (id: ${inst.id}). Its tools are now available via list_connector_tools({connector_id: "${inst.id}"}).` };
        }
        const msg = inst.status.kind === 'error' ? inst.status.message : inst.status.kind;
        return { content: `Added "${inst.display_name}" (id: ${inst.id}) but it could not connect yet: ${msg}. The user can retry it from the Connectors panel.` };
      } catch (err) {
        return errResult('E_INSTALL_FAILED', `could not add connector: ${(err as Error).message}`);
      }
    },
  };
}

/** Build the connector meta-tools for a single runner.
 *
 *  `mode` selects exposure (mirrors the tri-state gate in `runner.ts::connectorExposureFromSessionId`):
 *    - `'full'`     → both `list_connector_tools` + `call_connector_tool` (gconv commander
 *                     sessions — actual user tasks invoking external services).
 *    - `'discover'` → `list_connector_tools` only (agent-edit session — the editor LLM uses
 *                     it to learn each connector's actions so the authored workflow can name
 *                     specific action names like "gmail's `send_email`" instead of just
 *                     "gmail's email-sending feature". `call_connector_tool` is withheld so an
 *                     authoring session can never produce external side effects.).
 *
 *  Returns `[]` when uid is empty OR when the actor has no visible connectors — in that case
 *  the system prompt also doesn't carry the `## Connectors` block, so the tools have nothing
 *  to act on and would only confuse the model. */
export async function createConnectorMetaTools(
  opts: ConnectorMetaToolsOpts,
  mode: 'full' | 'discover' = 'full',
): Promise<AgentTool[]> {
  if (!opts.userId) return [];
  // The commander (full mode) always gets `add_custom_connector`, even with
  // zero connectors installed — that's the path to the FIRST one. The
  // discover-mode add tool is intentionally absent (agent-edit must not
  // produce side effects). The add tool needs a cid to route its confirm
  // dialog; without one we cannot safely expose it.
  const addTool = mode === 'full' && opts.cid
    ? [createAddCustomConnectorTool({ ...opts, cid: opts.cid })]
    : [];

  const visible = await resolveVisibleConnectors(opts.userId, opts.agentId);
  if (!visible.length) return addTool;
  if (mode === 'discover') return [createListConnectorToolsTool(opts)];
  return [
    createListConnectorToolsTool(opts),
    createCallConnectorToolTool(opts),
    ...addTool,
  ];
}
