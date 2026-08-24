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
 *      block injected into the system prompt — `getConnectorPromptBlock`. Runner construction
 *      uses `buildConnectorSurface` so this block and the meta-tools share one visibility
 *      snapshot. The block is stable per session and lives in the cached prefix; the model sees
 *      the names + descriptions without a discovery round-trip.
 *   2. Two meta-tools enable lazy disclosure of each connector's per-action schema:
 *        list_connector_tools(connector_id)        → MCP tool schemas for one connector
 *        call_connector_tool(connector_id, …)      → route to manager.callTool
 *   3. When NO connector is visible to this actor, both the prompt block and the meta-tools are
 *      omitted entirely — `tools[]` shrinks by two slots and the system prompt stays smaller.
 *
 * Visibility: group-chat commander and agent workers see every user-enabled connected instance.
 * The `enabled_subtools` instance-level whitelist further filters which actions each connector
 * advertises.
 *
 * Session-kind gate: callers (runner.ts) invoke this module for `gconv` full access and
 * `gmember` full access, plus `agent` edit-session discovery. Skill edit chats / KB-image
 * extraction / CLI dispatch / reflect / anon stay free of connector exposure.
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
  /** Optional actor id for redacted failure diagnostics; it never filters visibility. */
  agentId?: string;
  /** Conversation id — required for the task-session `add_custom_connector`
   *  tool so its confirmation dialog routes to the right conversation.
   *  Omitted for discover-mode (agent-edit) where add is not exposed. */
  cid?: string;
  /** Keep list/call schemas available for a live run that may gain a
   * connector after construction. */
  allowRuntimeRefresh?: boolean;
  /** Only the commander may offer installation of a custom MCP server. */
  allowCustomConnectorInstall?: boolean;
  /** UI-only display metadata refreshed by the same visibility checks. */
  connectorDisplayNameById?: Map<string, string>;
}

type VisibleConnectors = Awaited<ReturnType<typeof resolveVisibleConnectors>>;

function _recordVisibleConnectorDisplayNames(
  opts: ConnectorMetaToolsOpts,
  visible: VisibleConnectors,
): void {
  if (!opts.connectorDisplayNameById) return;
  for (const { instance } of visible) {
    const id = String(instance.id || '').trim();
    const name = String(instance.display_name || '').trim();
    if (id && name) opts.connectorDisplayNameById.set(id, name);
  }
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
  // `resolveVisibleConnectors` routes `connected` AND `degraded` (the latter so a tool call can
  // heal it), so a line is NOT implicitly healthy — a degraded one must say so. Keep the warning
  // host-authored: status.message may contain arbitrary remote/provider text and this block is
  // injected into the system prompt. The actual call can return its error as ordinary tool data.
  // Disconnected / errored / connecting instances remain hidden entirely — see tools-adapter.ts
  // for the filter + rationale.
  const catalog = findCatalogEntry(instance.id);
  const descKey = `description_${lang}` as 'description_zh' | 'description_en';
  const desc = catalog ? (catalog[descKey] || '') : '';
  const acct = instance.oauth_grant?.account_label ? ` (account: ${instance.oauth_grant.account_label})` : '';
  const warn = instance.status.kind === 'degraded'
    ? ' — ⚠️ UNVERIFIED: the last connection attempt failed. Calls may fail; if one does, report the connector error to the user rather than working around it.'
    : '';
  return desc
    ? `- **${instance.id}** — ${instance.display_name}: ${desc}${acct}${warn}`
    : `- **${instance.id}** — ${instance.display_name}${acct}${warn}`;
}

const MAX_RECOVERY_ACTIONS = 24;
const MAX_RECOVERY_ACTION_LIST_CHARS = 3_000;

function _unavailableActionMessage(cid: string, requestedTool: string, tools: ToolSchema[]): string {
  const boundedRequestedTool = String(requestedTool || '').slice(0, 160);
  const names: string[] = [];
  let renderedChars = 0;
  for (const tool of tools) {
    if (names.length >= MAX_RECOVERY_ACTIONS) break;
    const name = String(tool.name || '').trim().slice(0, 160);
    if (!name) continue;
    const nextChars = renderedChars + name.length + 3;
    if (nextChars > MAX_RECOVERY_ACTION_LIST_CHARS) break;
    names.push(name);
    renderedChars = nextChars;
  }
  const omitted = Math.max(0, tools.length - names.length);
  const lines = [
    `action "${boundedRequestedTool}" is not available on connector "${cid}".`,
    'Available actions:',
    ...names.map((name) => `- ${name}`),
  ];
  if (omitted) lines.push(`- ... ${omitted} more actions omitted`);
  lines.push('Choose an exact action name, then inspect its input schema before invoking it.');
  return lines.join('\n');
}

/** Render the `## Connectors` system-prompt block — pure enumeration (one line per connector).
 *  Returns `''` when nothing is visible; the caller skips concatenation in that case. The block
 *  is stable per session (only changes on connect / disconnect events) so it sits in the cached
 *  prompt prefix. The protocol for invoking connectors via the meta-tools is taught in the
 *  per-role chat prompts (`chat_commander.md` / `chat_agent_in_group.md`); the agent-edit
 *  prompt teaches the "reference connectors by id in the workflow" usage. The role
 *  prompts retain only the routing boundary; these meta-tool schemas own the detailed
 *  discovery, invocation, and success-evidence contract. */
function renderConnectorPromptBlock(uid: string, visible: VisibleConnectors): string {
  if (!visible.length) return '';
  const lang = _descriptionLangForUser(uid);
  const lines: string[] = ['## Connectors', ''];
  for (const { instance } of visible) lines.push(_renderConnectorLine(instance, lang));
  return lines.join('\n');
}

export async function getConnectorPromptBlock(uid: string): Promise<string> {
  if (!uid) return '';
  return renderConnectorPromptBlock(uid, await resolveVisibleConnectors(uid));
}

function createListConnectorToolsTool(opts: ConnectorMetaToolsOpts): AgentTool {
  return {
    name: 'list_connector_tools',
    // Kept sequential to match the connector-tool rule in
    // core-agent/src/tools/base.ts (connector tools stay sequential). Although
    // discovery is read-only, aligning with the documented rule avoids a future
    // side-effectful connector tool inheriting `parallel` by copy-paste.
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
          description: 'Optional visible connector id. Omit to discover valid ids.',
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const cid = typeof (input as { connector_id?: unknown }).connector_id === 'string'
        ? ((input as { connector_id: string }).connector_id).trim()
        : '';
      if (!cid) return errResult('E_BAD_INPUT', '`connector_id` is required (a non-empty string)');

      const visible = await resolveVisibleConnectors(opts.userId);
      const match = visible.find((v) => v.instance.id === cid);
      if (!match) {
        // resolveVisibleConnectors already filters to `status.kind === 'connected'`, so a miss
        // here means either the id is wrong OR the connector went disconnected between block
        // render and this call. Either way the LLM's recovery is identical (re-read the
        // `## Connectors` block, or ask the user to refresh) — one error code keeps it simple.
        return errResult(
          'E_CONNECTOR_NOT_VISIBLE',
          `connector "${cid}" is not currently available. Call \`list_connector_tools\` without connector_id to refresh valid ids; if it was available a moment ago, ask the user to refresh it in the Connectors panel.`,
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
      'Invoke a connector action using the schema returned by list_connector_tools. A successful tool call confirms transport only; claim an external side effect completed only when the returned response explicitly confirms it.',
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: {
          type: 'string',
          description: 'An exact visible id returned by `list_connector_tools` or the `## Connectors` block.',
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

      const visible = await resolveVisibleConnectors(opts.userId);
      _recordVisibleConnectorDisplayNames(opts, visible);
      const match = visible.find((v) => v.instance.id === cid);
      if (!match) {
        return errResult(
          'E_CONNECTOR_NOT_VISIBLE',
          `connector "${cid}" is not enabled for this conversation. Call \`list_connector_tools\` without connector_id to refresh valid ids.`,
        );
      }
      const toolMatch = match.tools.find((t) => t.name === toolName);
      if (!toolMatch) {
        return errResult(
          'E_TOOL_NOT_AVAILABLE',
          _unavailableActionMessage(cid, toolName, match.tools),
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

/** Task-session tool: install a user-described custom MCP server. The
 *  install ALWAYS requires the user to approve a confirmation dialog
 *  (plan §C2 / §C3) — for stdio that dialog shows the exact command that
 *  will run. The LLM can describe the server but cannot complete the
 *  install on its own. Bound to a cid so the confirm dialog routes to the
 *  right conversation. */
function createAddCustomConnectorTool(opts: ConnectorMetaToolsOpts & { cid: string }): AgentTool {
  return {
    name: 'add_custom_connector',
    description:
      'Add a specific custom MCP server only when explicitly requested by the user. Installation requires user confirmation; approved servers are then used through list_connector_tools and call_connector_tool.',
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
        const msg = (inst.status.kind === 'error' || inst.status.kind === 'degraded')
          ? inst.status.message
          : inst.status.kind;
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
 *    - `'full'`     → both `list_connector_tools` + `call_connector_tool` (gconv/gmember
 *                     sessions — actual user tasks invoking external services).
 *    - `'discover'` → `list_connector_tools` only (agent-edit session — the editor LLM uses
 *                     it to learn each connector's actions so the authored workflow can name
 *                     specific action names like "gmail's `send_email`" instead of just
 *                     "gmail's email-sending feature". `call_connector_tool` is withheld so an
 *                     authoring session can never produce external side effects.).
 *
 *  Returns `[]` when uid is empty. The add tool is a separate commander-only
 *  capability selected by `allowCustomConnectorInstall`; rich active-turn
 *  sessions may opt into a stable list/call schema whose execution resolves
 *  live state. */
function createConnectorMetaToolsFromVisible(
  opts: ConnectorMetaToolsOpts,
  mode: 'full' | 'discover',
  visible: VisibleConnectors,
): AgentTool[] {
  if (!opts.userId) return [];
  // Only a host-authorized commander gets `add_custom_connector`, even when
  // zero connectors are installed — that's the path to the first one. The add
  // tool needs a cid to route its confirm dialog; without one it is withheld.
  const addTool = mode === 'full' && opts.cid && opts.allowCustomConnectorInstall === true
    ? [createAddCustomConnectorTool({ ...opts, cid: opts.cid })]
    : [];

  if (!visible.length && !opts.allowRuntimeRefresh) return addTool;
  if (mode === 'discover') return [createListConnectorToolsTool(opts)];
  return [
    createListConnectorToolsTool(opts),
    createCallConnectorToolTool(opts),
    ...addTool,
  ];
}

/** Build both runner-facing Connector surfaces from one visibility snapshot.
 *  Besides avoiding a duplicate local catalog scan, this keeps the prompt
 *  catalog and the available meta-tools coherent if connector state changes
 *  while a runner is being assembled. Tool execution still resolves live
 *  visibility on every call. */
export async function buildConnectorSurface(
  opts: ConnectorMetaToolsOpts,
  mode: 'full' | 'discover' = 'full',
): Promise<{
  promptBlock: string;
  tools: AgentTool[];
  connectorDisplayNameById: Map<string, string>;
}> {
  const connectorDisplayNameById = new Map<string, string>();
  if (!opts.userId) return { promptBlock: '', tools: [], connectorDisplayNameById };
  const visible = await resolveVisibleConnectors(opts.userId);
  const scopedOpts = { ...opts, connectorDisplayNameById };
  _recordVisibleConnectorDisplayNames(scopedOpts, visible);
  return {
    promptBlock: renderConnectorPromptBlock(opts.userId, visible),
    tools: createConnectorMetaToolsFromVisible(scopedOpts, mode, visible),
    connectorDisplayNameById,
  };
}

export async function createConnectorMetaTools(
  opts: ConnectorMetaToolsOpts,
  mode: 'full' | 'discover' = 'full',
): Promise<AgentTool[]> {
  if (!opts.userId) return [];
  const visible = await resolveVisibleConnectors(opts.userId);
  return createConnectorMetaToolsFromVisible(opts, mode, visible);
}
