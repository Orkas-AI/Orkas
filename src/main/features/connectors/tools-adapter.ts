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
 * visibility rules (`connected` + user-enabled + `enabled_subtools`) are single-sourced.
 *
 * Visibility resolution is intentionally side-effect free. It only reads local connector state;
 * Server/MCP restore, cache refresh, reconnect, and token checks happen during explicit connector
 * management flows or when `manager.callTool` actually needs to use the connector.
 */
import * as manager from './manager';
import {
  isConnectorEnabledFromSnapshot,
  readEnabledMap,
} from '../component_enabled';
import { isConnectorRuntimeEnabled } from './availability';
import { findCatalogEntry } from './catalog';
import { isConnectorActionBlocked } from './action_policy';
import { isConnectorUsable } from './types';
import type { ConnectorInstance, ToolSchema } from './types';
import type { ToolResult, ToolResultImage } from '#core-agent';

/** Preserve protocol receipts alongside the human-readable description. */
export function stringifyMcpResult(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const obj = raw as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
    if (Array.isArray(obj.content)) {
      const textParts = obj.content
        .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string);
      if (textParts.length) {
        if (obj.structuredContent !== undefined) {
          try { textParts.push(JSON.stringify({ structuredContent: obj.structuredContent })); }
          catch { /* Non-serializable inputs cannot carry a protocol receipt. */ }
        }
        return textParts.join('\n');
      }
    }
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  return String(raw);
}

const MAX_CONNECTOR_IMAGE_COUNT = 4;
const MAX_CONNECTOR_IMAGE_BYTES = 5 * 1024 * 1024;
const CONNECTOR_IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/jpeg': bytes => bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
  'image/gif': bytes => /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6)),
  'image/webp': bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
};

type McpContentPart = {
  type?: string;
  mimeType?: unknown;
  data?: unknown;
  annotations?: { audience?: unknown };
};

function isMcpImage(part: McpContentPart | null): part is McpContentPart {
  return part?.type === 'image';
}

/** MCP images use the existing ToolResult transport, including program previews. */
export function formatNativeMcpResult(
  raw: unknown,
  legacyProgramByteLimit = 0,
): Pick<ToolResult, 'content' | 'images'> {
  const envelope = raw && typeof raw === 'object' ? raw as { content?: Array<McpContentPart | null> } : undefined;
  if (!Array.isArray(envelope?.content) || !envelope.content.some(isMcpImage)) {
    return { content: stringifyMcpResult(raw) };
  }

  let bytesLeft = MAX_CONNECTOR_IMAGE_BYTES;
  let omitted = 0;
  const images: ToolResultImage[] = [];
  const blocks = envelope.content.filter(part => {
    if (!isMcpImage(part)) return true;
    const { data, annotations } = part;
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const check = Object.hasOwn(CONNECTOR_IMAGE_SIGNATURES, mimeType)
      ? CONNECTOR_IMAGE_SIGNATURES[mimeType] : undefined;
    const audience = annotations?.audience;
    if (check && (!Array.isArray(audience) || audience.includes('assistant')) && typeof data === 'string'
      && data.length <= 4 * Math.ceil(bytesLeft / 3) && images.length < MAX_CONNECTOR_IMAGE_COUNT) {
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length <= bytesLeft && check(bytes) && bytes.toString('base64') === data) {
        bytesLeft -= bytes.length;
        images.push({ data, mediaType: mimeType });
        return false;
      }
    }
    omitted++;
    return false;
  });
  const content = blocks.length || 'structuredContent' in envelope
    ? stringifyMcpResult({ ...envelope, content: blocks })
    : images.length ? `Connector returned ${images.length} image(s).` : '';
  if (legacyProgramByteLimit && images.length && !omitted && !blocks.length) {
    // Existing scripts can decode a pure image receipt. Keep that copy only
    // when it fits beside the preview under the existing child result limit.
    const encodedBytes = images.reduce((bytes, image) => bytes + image.data.length, 0);
    const imageBytes = images.reduce((bytes, image, index) => bytes + (index ? 1 : 0)
      + Buffer.byteLength(JSON.stringify({ ...image, data: '' })), 2 + encodedBytes);
    // Skip serializing a duplicate payload that already exceeds the limit
    // before envelope overhead.
    if (encodedBytes + imageBytes <= legacyProgramByteLimit) {
      const legacy = stringifyMcpResult(raw);
      if (Buffer.byteLength(legacy) + imageBytes <= legacyProgramByteLimit) {
        return { content: legacy, images };
      }
    }
    return { content: [content, 'Connector images are attached to the model result. The legacy inline copy exceeds the program result limit.'].join('\n'), images };
  }
  const notice = omitted ? `Connector images omitted due to format, size, or audience limits: ${omitted}.` : '';
  return { content: [content, notice].filter(Boolean).join('\n'), ...(images.length ? { images } : {}) };
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
): Promise<Array<{ instance: ConnectorInstance; tools: ToolSchema[] }>> {
  if (!uid) return [];
  const all = manager.listInstances(uid);
  if (!all.length) return [];
  // Usable-state filter: a persisted `connected` row with cached schemas may not yet have a live
  // process/socket after restart; `manager.callTool` establishes that one connection on demand.
  // A `connecting` / `disconnected` / `error` row still stays hidden because it needs discovery
  // or repair before it can be routed safely.
  //
  // `degraded` stays visible on purpose — it means "authorized, cached tools, last attempt failed
  // for a reason we expect to recover". Hiding it would remove the only thing that heals it (a tool
  // call), stranding the connector until a manual reconnect. This is the retry question, which is
  // deliberately separate from what the UI renders: `isConnectorVerifiedLive` gates the green card,
  // `isConnectorUsable` gates routing. Conflating them is what let a six-day-dead connector show
  // as connected while `callTool` failed every time.
  const connected = all.filter((i) => isConnectorUsable(i.status) && isConnectorRuntimeEnabled(i.id));
  if (!connected.length) return [];
  // Per-user soft-disable filter (Connectors panel "停用" button). This applies to every actor;
  // even a connector with a valid grant and live MCP connection stays hidden until re-enabled.
  // Runner construction evaluates every instance together, so reuse one local
  // config snapshot instead of synchronously reading the same file N times.
  const enabledSnapshot = readEnabledMap(uid);
  const userEnabled = connected.filter((i) => (
    isConnectorEnabledFromSnapshot(enabledSnapshot, i.id)
  ));
  if (!userEnabled.length) return [];
  const resolved = userEnabled.map((instance) => {
    const userAllowed = instance.enabled_subtools;
    const catalogEntry = findCatalogEntry(instance.id);
    const catalogAllowed = catalogEntry?.allowed_tools;
    const filteredTools = catalogAllowed?.length
      ? instance.tools_cache.filter((t) => catalogAllowed.includes(t.name))
      : instance.tools_cache;
    // Catalog policy is trusted Host data. Always reapply it while projecting cached tools so a
    // legacy cache cannot omit the confirmation gate and provider-controlled MCP `_meta` cannot
    // override the reviewed risk classification.
    const productTools = catalogEntry?.tool_policies
      ? filteredTools.flatMap((tool) => {
        const policy = catalogEntry.tool_policies?.[tool.name];
        return policy ? [{ ...tool, orkas_action_policy: policy }] : [];
      })
      : filteredTools;
    const eligible = productTools.filter((tool) => !isConnectorActionBlocked(instance.id, tool.name));
    const tools = userAllowed === null
      ? eligible
      : eligible.filter((t) => userAllowed.includes(t.name));
    return { instance, tools };
  });
  return _dedupeGoogleWorkspaceTools(resolved);
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
