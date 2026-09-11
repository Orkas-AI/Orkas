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
import { requestActionConfirm, connectorAccountKey } from '../../features/connectors/action_confirm';
import { connectorActionRisk, isConnectorActionBlocked } from '../../features/connectors/action_policy';
import { findCatalogEntry } from '../../features/connectors/catalog';
import { resolveLanguageForUser } from '../../features/config';
import { descriptionLang } from '../../i18n';
import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import type { ConnectorInstance, ToolSchema } from '../../features/connectors/types';

const log = createLogger('connector-meta-tools');
const MAX_INLINE_CONNECTOR_TOOLS_CHARS = 30_000;
const MAX_RECOVERY_ACTIONS = 24;
const MAX_RECOVERY_ACTION_LIST_CHARS = 3_000;

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
  /** Host-side post-success hook. It may expose a review shortcut but must
   * never authorize or perform the installation itself. */
  onCustomConnectorAdded?: (connectorId: string) => void;
  /** UI-only display metadata refreshed by the same visibility checks. */
  connectorDisplayNameById?: Map<string, string>;
}

type VisibleConnectors = Awaited<ReturnType<typeof resolveVisibleConnectors>>;

function _recordVisibleConnectorDisplayNames(
  opts: ConnectorMetaToolsOpts,
  visible: VisibleConnectors,
): void {
  if (!opts.connectorDisplayNameById) return;
  const lang = _descriptionLangForUser(opts.userId);
  for (const { instance } of visible) {
    const id = String(instance.id || '').trim();
    const name = _localizedConnectorDisplayName(instance, lang);
    if (id && name) opts.connectorDisplayNameById.set(id, name);
  }
}

function _argumentsWithinBatchLimit(value: unknown, limit: number): boolean {
  if (!Number.isInteger(limit) || limit < 1) return false;
  if (Array.isArray(value)) {
    return value.length <= limit && value.every((item) => _argumentsWithinBatchLimit(item, limit));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .every((item) => _argumentsWithinBatchLimit(item, limit));
  }
  return true;
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

function _jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

function _schemaArgSummary(schema: Record<string, unknown> | undefined): string {
  const props = schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(schema?.required) ? new Set(schema.required.map(String)) : new Set<string>();
  const keys = Object.keys(props).slice(0, 12).map((key) => required.has(key) ? key : `${key}?`);
  const suffix = Object.keys(props).length > keys.length ? ', ...' : '';
  return keys.length ? ` args: ${keys.join(', ')}${suffix}` : ' args: {}';
}

function _shortDescription(text: string | undefined): string {
  const compact = String(text || '(no description)').replace(/\s+/g, ' ').trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

function _renderSingleToolSchema(cid: string, tool: ToolSchema): string {
  return [
    `Action on connector "${cid}": ${tool.name}`,
    tool.description || '(no description)',
    '',
    'Invoke via:',
    `\`call_connector_tool({connector_id: "${cid}", tool_name: "${tool.name}", args: {…}})\``,
    '',
    'Input schema:',
    '```json',
    _jsonStringify(tool.input_schema ?? {}),
    '```',
  ].join('\n').trimEnd();
}

function _renderCompactToolList(cid: string, tools: ToolSchema[]): string {
  const lines: string[] = [
    `Actions on connector "${cid}" (${tools.length}).`,
    `Call \`list_connector_tools({connector_id: "${cid}", tool_name: "<name>"})\` to expand one action's JSON input schema, then invoke it via ` +
      `\`call_connector_tool({connector_id: "${cid}", tool_name: "<name>", args: {…}})\`.`,
    '',
  ];
  for (const t of tools) {
    lines.push(`- **${t.name}** — ${_shortDescription(t.description)} (${_schemaArgSummary(t.input_schema)})`);
  }
  return lines.join('\n').trimEnd();
}

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
  lines.push(
    'Choose an exact action name. Call ' +
      `list_connector_tools({connector_id: "${cid}", tool_name: "<exact-name>"}) ` +
      'to obtain its input schema before invoking it.',
  );
  return lines.join('\n');
}

function _descriptionLangForUser(uid: string): 'zh' | 'en' {
  try {
    return descriptionLang(resolveLanguageForUser(uid));
  } catch {
    return 'en';
  }
}

function _localizedConnectorDisplayName(instance: ConnectorInstance, lang: 'zh' | 'en'): string {
  const catalog = findCatalogEntry(instance.id);
  const localized = lang === 'zh' ? catalog?.display_name_zh : catalog?.display_name_en;
  return String(localized || catalog?.display_name || instance.display_name || instance.id).trim();
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
  const displayName = _localizedConnectorDisplayName(instance, lang);
  const descKey = `description_${lang}` as 'description_zh' | 'description_en';
  const desc = catalog ? (catalog[descKey] || '') : '';
  const acct = instance.oauth_grant?.account_label ? ` (account: ${instance.oauth_grant.account_label})` : '';
  const warn = instance.status.kind === 'degraded'
    ? ' — ⚠️ UNVERIFIED: the last connection attempt failed. Calls may fail; if one does, report the connector error to the user rather than working around it.'
    : '';
  return desc
    ? `- **${instance.id}** — ${displayName}: ${desc}${acct}${warn}`
    : `- **${instance.id}** — ${displayName}${acct}${warn}`;
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
      'List visible connector ids when connector_id is omitted. With a connector_id, list its actions; add tool_name to return one action\'s full input schema before calling call_connector_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        connector_id: {
          type: 'string',
          description: 'Optional visible connector id. Omit to discover valid ids.',
        },
        tool_name: {
          type: 'string',
          description: 'Optional action name. When provided, returns only that action with its full input schema.',
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const cid = typeof (input as { connector_id?: unknown }).connector_id === 'string'
        ? ((input as { connector_id: string }).connector_id).trim()
        : '';
      const requestedTool = typeof (input as { tool_name?: unknown }).tool_name === 'string'
        ? ((input as { tool_name: string }).tool_name).trim()
        : '';
      if (!cid && requestedTool) {
        return errResult('E_BAD_INPUT', '`connector_id` is required when `tool_name` is provided');
      }
      const visible = await resolveVisibleConnectors(opts.userId);
      _recordVisibleConnectorDisplayNames(opts, visible);
      if (!cid) {
        const content = visible.length
          ? [
            'Visible connectors. Choose an exact id, then call `list_connector_tools` again with `connector_id`.',
            '',
            ...visible.map(({ instance }) => _renderConnectorLine(
              instance,
              _descriptionLangForUser(opts.userId),
            )),
          ].join('\n')
          : 'No connectors are currently visible to this Agent. Ask the user to select or enable one.';
        return { content };
      }
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
      if (requestedTool) {
        const tool = match.tools.find((t) => t.name === requestedTool);
        if (!tool) {
          return errResult(
            'E_TOOL_NOT_AVAILABLE',
            _unavailableActionMessage(cid, requestedTool, match.tools),
          );
        }
        return { content: _renderSingleToolSchema(cid, tool) };
      }

      const lines: string[] = [
        `Actions on connector "${cid}". Invoke any of them via ` +
        `\`call_connector_tool({connector_id: "${cid}", tool_name: "<name>", args: {…}})\` — ` +
        '`args` MUST match the listed input_schema verbatim. If this response is compact, call ' +
        `\`list_connector_tools({connector_id: "${cid}", tool_name: "<name>"})\` for one action's schema.`,
        '',
      ];
      for (const t of match.tools) {
        lines.push(`### ${t.name}`);
        lines.push(t.description || '(no description)');
        lines.push('');
        lines.push('Input schema:');
        lines.push('```json');
        lines.push(_jsonStringify(t.input_schema ?? {}));
        lines.push('```');
        lines.push('');
      }
      const full = lines.join('\n').trimEnd();
      const compact = full.length > MAX_INLINE_CONNECTOR_TOOLS_CHARS;
      const content = compact ? _renderCompactToolList(cid, match.tools) : full;
      return { content };
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
    async execute(input, ctx) {
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
      if (!toolMatch || isConnectorActionBlocked(cid, toolName)) {
        return errResult(
          'E_TOOL_NOT_AVAILABLE',
          _unavailableActionMessage(cid, toolName, match.tools),
        );
      }

      try {
        const normalizedArgs = applyConnectorArgDefaults(cid, toolName, args, toolMatch.input_schema);
        const policy = toolMatch.orkas_action_policy;
        const catalogEntry = findCatalogEntry(cid);
        const isComposioCommerce = !!match.instance.composio_grant
          && catalogEntry?.category === 'commerce';
        const isCatalogGovernedRemoteCommerce = !match.instance.composio_grant
          && catalogEntry?.category === 'commerce'
          && !!catalogEntry.tool_policies;
        if ((isComposioCommerce || isCatalogGovernedRemoteCommerce) && !policy) {
          return errResult(
            'E_CONNECTOR_POLICY_MISSING',
            'This commerce action has no trusted action policy. Ask the user to refresh the connector before retrying.',
          );
        }
        if (policy && !_argumentsWithinBatchLimit(normalizedArgs, policy.max_batch_size)) {
          return errResult(
            'E_CONNECTOR_BATCH_LIMIT',
            `This connector action accepts at most ${policy.max_batch_size} items in any array argument. Split the request into smaller batches.`,
          );
        }
        const actionRisk = connectorActionRisk(match.instance, toolMatch);
        if (actionRisk.risk === 'H' || actionRisk.risk === 'D') {
          const approved = await requestActionConfirm({
            userId: opts.userId,
            cid: opts.cid,
            connectorId: cid,
            displayName: _localizedConnectorDisplayName(
              match.instance,
              _descriptionLangForUser(opts.userId),
            ),
            accountKey: connectorAccountKey(match.instance),
            accountLabel: match.instance.composio_grant?.account_label
              || match.instance.oauth_grant?.account_label,
            toolName,
            risk: actionRisk.risk,
            sensitiveOperation: actionRisk.sensitive_operation,
            args: normalizedArgs,
            signal: ctx.signal,
          });
          if (!approved) {
            return errResult(
              ctx.signal?.aborted ? 'E_TOOL_CALL_CANCELLED' : 'E_CONNECTOR_CONFIRMATION_DENIED',
              ctx.signal?.aborted
                ? 'The connector action was cancelled.'
                : 'The sensitive connector action was not approved by the user.',
            );
          }
        }
        const raw = await manager.callTool(opts.userId, cid, toolName, normalizedArgs, { signal: ctx.signal });
        const content = stringifyMcpResult(raw);
        const protocolError = !!raw && typeof raw === 'object' && (raw as { isError?: unknown }).isError === true;
        return protocolError ? { content, isError: true } : { content };
      } catch (err) {
        const msg = (err as Error).message;
        log.warn('call_connector_tool failed', { connector_id: maskId(cid), tool: toolName, error: logErrorRef(err) });
        return {
          content: `Error calling ${cid}/${toolName}: ${msg}`,
          isError: true,
        };
      }
    },
  };
}

/** Shared by the in-process connector tools and the external-CLI bridge so
 *  the same account, connector and action map to the same provider request. */
export function applyConnectorArgDefaults(
  connectorId: string,
  toolName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const out: Record<string, unknown> = { ...args };
  for (const key of Object.keys(properties)) {
    if (!key.includes('_') || Object.prototype.hasOwnProperty.call(out, key)) continue;
    const camel = key.replace(/_([a-z])/g, (_m: string, ch: string) => ch.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(out, camel)) {
      out[key] = out[camel];
      delete out[camel];
    }
  }
  return out;
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
      'Add a specific custom MCP server only when the user explicitly requested it and already supplied the exact non-secret configuration. Installation requires user confirmation. Never ask the user to paste a missing credential, API key, or token into chat; when protected input is still required, navigate to Connectors > Add MCP server instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short display name for the server.' },
        transport: {
          type: 'object',
          description:
            'Either { kind: "streamable-http", url, headers? } for a remote server, or '
            + '{ kind: "stdio", command, args?, env? } for a local command. Use only exact '
            + 'values already supplied in the current user request; never invent or solicit secret values in chat.',
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
        try { opts.onCustomConnectorAdded?.(inst.id); }
        catch { log.warn('custom connector post-success hook failed', { connector_id: 'custom', error_code: 'post_success_hook_failed' }); }
        if (inst.status.kind === 'connected') {
          return { content: `Connected "${inst.display_name}" (id: ${inst.id}). Its tools are now available via list_connector_tools({connector_id: "${inst.id}"}).` };
        }
        return { content: `Added "${inst.display_name}" (id: ${inst.id}) but it could not connect yet. Ask the user to review the protected configuration in Connectors and retry there.` };
      } catch (err) {
        return errResult('E_INSTALL_FAILED', 'could not add connector. Ask the user to review the protected Connectors form and retry there.');
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
