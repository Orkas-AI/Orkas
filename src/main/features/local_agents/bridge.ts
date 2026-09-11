/**
 * orkas-bridge host — lets an external CLI agent (claude code / codex)
 * perceive and call the Orkas environment (plan §D).
 *
 * Per CLI dispatch the runner starts one host: a local-IPC socket server
 * (unix domain socket / Windows named pipe — NOT a TCP port, per the
 * PC/CLAUDE.md "no occupied port" boundary) plus a generated MCP server
 * config file. The CLI agent spawns `bin/orkas-bridge.cjs` as a stdio MCP
 * server; that client connects back here and proxies tool calls.
 *
 * Auth: a per-run random token lives in a 0600 env file consumed by the
 * spawned server and must prefix every request; the socket file lives in
 * os.tmpdir() with 0600 modes. The token dies with the run (`close()`).
 *
 * Capability surface (decisions I15–I17 plus the least-privilege update in
 * I31 in the plan):
 *   - skills.list / skills.read / skills.run_info — trusted + external
 *     package skills, disabled ids filtered; reads/runs are path-checked
 *     against listed skill dirs.
 *   - connectors.list / connectors.call — registered only when the ordinary
 *     group-chat Agent connector policy resolves at least one user-connected,
 *     enabled connector; actions use Orkas operation permissions independently
 *     of native CLI approvals.
 *   - library — reuses the in-process Library tool's list/search/read actions,
 *     scoped to global + current project when the conversation belongs to a
 *     project.
 *   - chat_history — reuses the in-process conversation-history tool's
 *     search/read actions with a host-bound current-only scope and
 *     triggering-message bound.
 *   - todo_tasks — paged backlog reads and task creation/updates for the host-bound project;
 *     available only when the current conversation belongs to a project.
 *   - memory.agent — reads and updates the calling Agent's durable memory;
 *     uid and agentId are bound by the host and never accepted from the model.
 *   - commander.handoff — records one bounded, run-local request for the bus;
 *     it does not expose any Commander mutation or orchestration method.
 *
 * Protocol: NDJSON over the socket.
 *   request  {id, token, method, params}
 *   response {id, ok, result} | {id, ok:false, error}
 * First request with a bad token destroys the connection.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import { resolveBackgroundNodeRuntime, withBackgroundNodeEnv } from '../../util/background-node';
import { listSkillsForBridge, type BridgeSkillRow } from '../../model/core-agent/skill-registry';
import { readDisabledSets } from '../component_enabled';
import { createLibraryTool } from '../../model/core-agent/kb-tools';
import { createChatHistoryTool } from '../../model/core-agent/chat-history-tools';
import { projectExists, readProjectInstructions, writeProjectInstructionsIfUnchanged } from '../projects';
import * as projectFiles from '../project_files';
import * as memory from '../memory';
import { getWorkspacePath } from '../user_workspace';
import { isPathAllowed } from '../../util/path-sandbox';
import { buildConversationBrowserTool } from '../group_chat/browser_tool';
import { browserTaskRunId } from '../web_assist_lifecycle';
import { getActiveUserId } from '../users';
import { applyConnectorArgDefaults } from '../../model/core-agent/connector-meta-tools';
import {
  addAgentEntry,
  listAgentEntries,
  removeAgentEntry,
  replaceAgentEntry,
} from '../memory';
import * as connectors from '../connectors';
import { requestActionConfirm } from '../connectors/action_confirm';
import { connectorActionRisk, isConnectorActionBlocked } from '../connectors/action_policy';
import {
  localCliCapabilities,
  localCliSupportsAgentMemory,
  type LocalCliPermissionPolicy,
  type LocalCliType,
} from './registry';

const log = createLogger('local-agents:bridge');

const MAX_LINE_BYTES = 1024 * 1024;
const CONNECTOR_RESULT_CAP = 100_000;

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

function bridgeLogContext(opts: Pick<StartBridgeOpts, 'uid' | 'cid' | 'agentId' | 'projectId' | 'runId' | 'configDir'>, socketPath?: string): Record<string, unknown> {
  return {
    run_id: maskId(opts.runId),
    user_id: maskId(opts.uid),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    project_id: maskId(opts.projectId),
    config_dir: logPathRef(opts.configDir),
    socket: socketPath ? logPathRef(socketPath) : undefined,
  };
}

export interface BridgeHandle {
  socketPath: string;
  token: string;
  /** Path of the generated MCP config file (claude `--mcp-config`). */
  mcpConfigPath: string;
  /** Non-secret env block used to launch orkas-bridge.cjs. */
  serverEnv: Record<string, string>;
  /** Exact MCP/RPC capability categories granted to this run. */
  capabilities: readonly BridgeCapability[];
  /** First accepted Commander handoff request, if the CLI made one. */
  getCommanderHandoff(): CommanderHandoffRequest | null;
  /** UI-only display metadata for a Skill already admitted to this run's
   * source/enablement scope. The runner uses it to keep internal ids out of
   * persisted process labels without rescanning Skill roots. */
  getSkillDisplayName(ref: string): string | null;
  /** UI-only display metadata for a Connector already admitted by the same
   * connected + enabled policy that grants this run connector capability. */
  getConnectorDisplayName(id: string): string | null;
  close(): Promise<void>;
}

export type BridgeCapability =
  | 'browser'
  | 'skills.read'
  | 'skills.run'
  | 'connectors'
  | 'kb.read'
  | 'chat.read'
  | 'tasks.read'
  | 'tasks.write'
  | 'automation'
  | 'memory.agent'
  | 'project.context.write'
  | 'commander.handoff';

export interface CommanderHandoffRequest {
  reason: string;
  context?: string;
}

export interface StartBridgeOpts {
  uid: string;
  cid: string;
  agentId: string;
  agentName: string;
  conversationTitle?: string;
  cli: LocalCliType;
  permissionPolicy: LocalCliPermissionPolicy;
  /** Inbound message that triggered this CLI run. Current history stops
   * strictly before it. */
  currentMessageId: string;
  /** Current conversation project, if any. Enables project + global Library tools. */
  projectId?: string;
  /** Host-resolved CLI working directory; never supplied by an RPC caller. */
  workingDir?: string;
  runId: string;
  /** Where to write the per-run mcp-config file (the persist run dir). */
  configDir: string;
  /** Static skill-sandbox env (ORKAS_NODE / ORKAS_PC_DIR /
   *  ORKAS_WORKSPACE_ROOT plus bundled runtimes). The bridge replaces the
   *  Electron-flavoured ORKAS_NODE with ORKAS_BUNDLED_NODE so headless helper
   *  launches never inherit the macOS GUI application identity. */
  sandboxEnv: Record<string, string>;
  /** Keep the owning run visibly alive while a connector approval waits. */
  onPermissionWaiting?: (elapsedMs: number) => void;
  /** Suspend only the caller's idle clock while awaiting authorization. */
  onPermissionWaitStart?: () => () => void;
  /** A resumed CLI may call a Skill id learned in an earlier turn before
   * invoking skills.list in this host. Prime display metadata only for that
   * path; fresh runs keep Skill discovery lazy. */
  preloadSkillDisplayNames?: boolean;
}

function _socketPath(runId: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\orkas-bridge-${runId}`;
  // tmpdir keeps the path well under the unix sun_path limit (~104 bytes)
  // — the per-uid data root can be arbitrarily deep.
  return path.join(os.tmpdir(), `orkas-bridge-${runId}.sock`);
}

/** `signal` aborts when the client withdrew this request (its own timeout or
 *  an MCP cancellation) or asked `connectors.cancel` for it. */
type BridgeMethod = (
  params: Record<string, unknown>,
  call: { signal: AbortSignal },
) => Promise<unknown>;

const BASE_CAPABILITIES: readonly BridgeCapability[] = [
  'skills.read',
  'skills.run',
  'kb.read',
  'chat.read',
  'commander.handoff',
];

type AgentMemoryAction = 'add' | 'replace' | 'remove' | 'list';

const AGENT_MEMORY_ACTION_FIELDS: Readonly<Record<AgentMemoryAction, ReadonlySet<string>>> = {
  add: new Set(['action', 'target', 'content']),
  replace: new Set(['action', 'target', 'content', 'old_text']),
  remove: new Set(['action', 'target', 'old_text']),
  list: new Set(['action', 'target']),
};

async function _capabilitiesForRun(
  opts: StartBridgeOpts,
  recordConnectorDisplayName: (id: string, name: string) => void,
): Promise<BridgeCapability[]> {
  const browser: BridgeCapability[] = localCliCapabilities(opts.cli).orkasBridge
    && browserTaskRunId(opts.uid, opts.cid) ? ['browser'] : [];
  // OpenCode opts into the current-task browser and current-project tasks.
  // MCP transport must not implicitly grant the broader Claude/Codex surface.
  if (opts.cli === 'opencode') {
    return opts.projectId && await projectExists(opts.uid, opts.projectId) ? [...browser, 'tasks.read', 'tasks.write', 'automation'] : browser;
  }
  const capabilities = [...BASE_CAPABILITIES, ...browser];
  if (opts.projectId && await projectExists(opts.uid, opts.projectId)) {
    capabilities.push('tasks.read', 'tasks.write', 'automation');
    if (localCliSupportsAgentMemory(opts.cli)) capabilities.push('project.context.write');
  }
  if (localCliSupportsAgentMemory(opts.cli)) capabilities.push('memory.agent');
  try {
    // Match the ordinary gmember path in core-agent/runner: group-chat Agents
    // share the user's connected + enabled connector set.
    const visible = await connectors.resolveVisibleConnectors(opts.uid);
    if (visible.length) {
      capabilities.push('connectors');
      for (const { instance } of visible) {
        recordConnectorDisplayName(instance.id, instance.display_name);
      }
    }
  } catch (err) {
    // Connector discovery is optional for the CLI bridge. Fail this category
    // closed without taking away skills, Library, chat, or handback.
    log.warn('bridge connector capability resolution failed', {
      ...bridgeLogContext(opts),
      error: logErrorRef(err),
    });
  }
  return capabilities;
}

function _buildMethods(
  opts: StartBridgeOpts,
  capabilities: ReadonlySet<BridgeCapability>,
  recordCommanderHandoff: (request: CommanderHandoffRequest) => boolean,
  recordConnectorDisplayName: (id: string, name: string) => void,
  isBridgeActive: () => boolean,
): {
  methods: Record<string, BridgeMethod>;
  preloadSkillDisplayNames(): Promise<void>;
  getSkillDisplayName(ref: string): string | null;
} {
  // Read-only model tools are reused as-is; map by tool name for dispatch.
  const readTools = new Map([
    createLibraryTool({
      userId: opts.uid,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    }),
    createChatHistoryTool({
      userId: opts.uid,
      currentCid: opts.cid,
      currentMessageId: opts.currentMessageId,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      allowedScopes: ['current'],
    }),
  ].map((t) => [t.name, t]));
  const runReadTool = async (name: string, params: Record<string, unknown>) => {
    const tool = readTools.get(name);
    if (!tool) throw new Error(`read tool unavailable: ${name}`);
    const result = await tool.execute(params, { state: {} } as never);
    const content = result?.content;
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : [])
        .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? c.text || '' : ''))
        .join('\n');
    if (result?.isError) throw new Error(text || 'read tool failed');
    return { text };
  };

  let skillRowsCache: BridgeSkillRow[] | null = null;
  const listSkills = async (): Promise<BridgeSkillRow[]> => {
    if (skillRowsCache) return skillRowsCache;
    try {
      const users = await import('../users');
      if (users.getActiveUserId() === opts.uid) {
        const skills = await import('../skills');
        await skills.repairLegacySkillEnabledIdsForActiveUser();
      }
    } catch (err) {
      log.warn('bridge legacy skill enabled-state repair failed', {
        user_id: maskId(opts.uid),
        error: (err as Error).message,
      });
    }
    const disabled = readDisabledSets(opts.uid).skills;
    const rows = (await listSkillsForBridge(opts.uid)).filter((r) => !disabled.has(r.id));
    skillRowsCache = rows;
    return rows;
  };
  const getSkillDisplayName = (ref: string): string | null => {
    const normalized = String(ref || '').trim();
    if (!normalized || !skillRowsCache) return null;
    const row = skillRowsCache.find((candidate) => candidate.id === normalized)
      || skillRowsCache.find((candidate) => candidate.name === normalized);
    return row?.name || null;
  };

  const methods: Record<string, BridgeMethod> = {};

  if (capabilities.has('browser')) {
    // CLI runtimes may issue parallel calls; never race a page mutation with
    // another observation/action. Capture the task turn once, not per call.
    let signal: AbortSignal | undefined;
    const browser = buildConversationBrowserTool(opts.uid, opts.cid,
      () => isBridgeActive() && !signal?.aborted && getActiveUserId() === opts.uid);
    let tail: Promise<unknown> = Promise.resolve();
    methods.browser = (params, call) => {
      const next = tail.then(async () => {
        signal = call.signal;
        return browser.execute(params, { state: {} } as never);
      });
      tail = next.catch(() => undefined);
      return next;
    };
  }

  if (capabilities.has('skills.read')) Object.assign(methods, {
    'skills.list': async () => {
      const rows = await listSkills();
      return {
        skills: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, source: r.source })),
      };
    },

    'skills.read': async (params) => {
      const ref = String(params.id || '').trim();
      if (!ref) throw new Error('id required');
      const rows = await listSkills();
      const row = rows.find((r) => r.id === ref) || rows.find((r) => r.name === ref);
      if (!row) throw new Error(`unknown skill: ${ref}`);
      // Path discipline: only the SKILL.md of a listed row is readable —
      // the bridge never becomes a generic file-read channel.
      const text = fs.readFileSync(row.skillFile, 'utf8');
      return { id: row.id, name: row.name, source: row.source, dir: row.dir, skill_md: text };
    },
  });

  if (capabilities.has('skills.run')) Object.assign(methods, {
    'skills.run_info': async (params) => {
      const ref = String(params.id || '').trim();
      if (!ref) throw new Error('id required');
      const rows = await listSkills();
      const row = rows.find((r) => r.id === ref) || rows.find((r) => r.name === ref);
      if (!row) throw new Error(`unknown skill: ${ref}`);
      return { id: row.id, name: row.name, source: row.source, dir: row.dir };
    },
  });

  if (capabilities.has('connectors')) Object.assign(methods, {
    'connectors.list': async () => {
      const visible = await connectors.resolveVisibleConnectors(opts.uid);
      for (const { instance } of visible) {
        recordConnectorDisplayName(instance.id, instance.display_name);
      }
      return {
        connectors: visible.map(({ instance, tools }) => ({
          id: instance.id,
          name: instance.display_name,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        })),
      };
    },

    'connectors.call': async (params, call) => {
      const connectorId = String(params.connector_id || '');
      const toolName = String(params.tool_name || '');
      const rawArgs = (params.args && typeof params.args === 'object') ? params.args as Record<string, unknown> : {};
      if (!connectorId || !toolName) throw new Error('connector_id and tool_name required');
      // The client stops waiting on its own timeout or an MCP cancel. Once it
      // has, no later user approval may run the side effect: the model has
      // already been told the call failed and may have retried it.
      const cancelled = () => new Error('E_BRIDGE_CALL_CANCELLED: the CLI stopped waiting for this connector call');
      if (call.signal.aborted) throw cancelled();
      const visible = await connectors.resolveVisibleConnectors(opts.uid);
      for (const { instance } of visible) {
        recordConnectorDisplayName(instance.id, instance.display_name);
      }
      const target = visible.find((v) => v.instance.id === connectorId);
      if (!target) throw new Error(`connector not available: ${connectorId}`);
      const tool = target.tools.find((item) => item.name === toolName);
      if (!tool) {
        throw new Error(`tool not exposed by connector ${connectorId}: ${toolName}`);
      }
      if (isConnectorActionBlocked(connectorId, toolName)) {
        throw new Error('E_CONNECTOR_ACTION_UNAVAILABLE: this action is not available in Orkas');
      }
      // Same normalisation as the in-process `call_connector_tool` (camelCase
      // keys, Gmail defaults): an external CLI must not reach the provider with
      // a different request shape than a built-in Agent for the same action.
      const args = applyConnectorArgDefaults(
        connectorId,
        toolName,
        rawArgs,
        (tool.input_schema && typeof tool.input_schema === 'object')
          ? tool.input_schema as Record<string, unknown>
          : undefined,
      );
      const policy = tool.orkas_action_policy;
      const isComposioCommerce = !!target.instance.composio_grant
        && connectors.findCatalogEntry(connectorId)?.category === 'commerce';
      if (isComposioCommerce && !policy) {
        throw new Error('E_CONNECTOR_POLICY_MISSING: this commerce action has no trusted policy');
      }
      if (policy && !_argumentsWithinBatchLimit(args, policy.max_batch_size)) {
        throw new Error(`E_CONNECTOR_BATCH_LIMIT: at most ${policy.max_batch_size} items are allowed in any array argument`);
      }

      if (call.signal.aborted) throw cancelled();
      const actionRisk = connectorActionRisk(target.instance, tool);
      if (actionRisk.risk === 'H' || actionRisk.risk === 'D') {
        const resumeIdle = opts.onPermissionWaitStart?.();
        let approved: boolean;
        try {
          approved = await requestActionConfirm({
            userId: opts.uid,
            cid: opts.cid,
            connectorId,
            displayName: target.instance.display_name,
            accountLabel: target.instance.composio_grant?.account_label
              || target.instance.oauth_grant?.account_label,
            toolName,
            risk: actionRisk.risk,
            sensitiveOperation: actionRisk.sensitive_operation,
            args,
            signal: call.signal,
            onWaiting: opts.onPermissionWaiting,
          });
        } finally {
          resumeIdle?.();
        }
        if (call.signal.aborted) throw cancelled();
        if (!approved) {
          throw new Error('E_CONNECTOR_CONFIRMATION_DENIED: the user declined this sensitive connector action');
        }
      }

      const raw = await connectors.callTool(opts.uid, connectorId, toolName, args, {
        signal: call.signal,
      });
      const text = connectors.stringifyMcpResult(raw);
      const capped = text.length > CONNECTOR_RESULT_CAP
        ? `${text.slice(0, CONNECTOR_RESULT_CAP)}\n… [truncated by orkas-bridge at ${CONNECTOR_RESULT_CAP} chars]`
        : text;
      return { text: capped };
    },
  });

  if (capabilities.has('kb.read')) Object.assign(methods, {
    library: async (params) => runReadTool('library', params),
  });

  if (capabilities.has('chat.read')) Object.assign(methods, {
    chat_history: async (params) => runReadTool('chat_history', params),
  });

  if (capabilities.has('automation') && opts.projectId) Object.assign(methods, {
    auto_tasks: async (params) => {
      const { createAutoTasksTool } = await import('../auto_tasks_tool');
      const result = await createAutoTasksTool({ userId: opts.uid, cid: opts.cid, projectId: opts.projectId }).execute(params, { state: {} });
      const receipt = JSON.parse(result.content);
      if (result.isError) throw new Error(receipt.error || 'automation operation failed');
      return receipt;
    },
  });

  if (capabilities.has('tasks.read') && opts.projectId) Object.assign(methods, {
    todo_tasks: async (params) => {
      if (!(await projectExists(opts.uid, opts.projectId!))) throw new Error('project_not_found');
      const readOnly = !capabilities.has('tasks.write');
      const { createProjectTasksTool } = await import('../../../core-agent/src/tools/project-tasks-tool');
      const { createProjectTasksHandler } = await import('../project_tasks_tool_handler');
      const names = new Map<string, string>();
      if (!readOnly && typeof params.owner === 'string' && params.owner.trim()) {
        const { getActiveUserId } = await import('../users');
        if (getActiveUserId() !== opts.uid) throw new Error('account_changed');
        const { listAgentSummaries } = await import('../agents');
        const agents = await listAgentSummaries();
        if (getActiveUserId() !== opts.uid) throw new Error('account_changed');
        for (const agent of agents) names.set(agent.agent_id, agent.name || agent.agent_id);
      }
      // Reads and writes share native validation, paging, scope and execution facts.
      const tool = createProjectTasksTool(createProjectTasksHandler(opts.uid, opts.projectId!, opts.cid, names, {
        actorId: opts.agentId,
      }), { readOnly });
      const result = await tool.execute(params, { state: {} });
      const receipt = JSON.parse(result.content);
      if (result.isError) throw new Error(receipt.error || 'task operation failed');
      return receipt;
    },
  });

  if (capabilities.has('memory.agent')) Object.assign(methods, {
    'memory.agent': async (params) => {
      const action = String(params.action || '') as AgentMemoryAction;
      const allowedFields = AGENT_MEMORY_ACTION_FIELDS[action];
      if (!allowedFields) throw new Error('action must be one of: add, replace, remove, list');
      const unrelated = Object.keys(params).filter((key) => !allowedFields.has(key));
      if (unrelated.length) {
        throw new Error(`fields not allowed for ${action}: ${unrelated.sort().join(', ')}`);
      }
      const target = params.target === undefined ? 'agent' : String(params.target);
      if (target === 'project' && capabilities.has('project.context.write') && opts.projectId) {
        if (!(await projectExists(opts.uid, opts.projectId))) throw new Error('project_not_found');
        const scope = { project: opts.projectId };
        switch (action) {
          case 'add': return memory.addEntry(opts.uid, scope, String(params.content || ''));
          case 'replace': return memory.replaceEntry(opts.uid, scope, String(params.old_text || ''), String(params.content || ''));
          case 'remove': return memory.removeEntry(opts.uid, scope, String(params.old_text || ''));
          case 'list': return memory.listEntries(opts.uid, scope);
        }
      }
      if (target !== 'agent') throw new Error('target must be "agent" for an external CLI Agent');

      switch (action) {
        case 'add':
          return addAgentEntry(opts.uid, opts.agentId, String(params.content || ''));
        case 'replace':
          return replaceAgentEntry(
            opts.uid,
            opts.agentId,
            String(params.old_text || ''),
            String(params.content || ''),
          );
        case 'remove':
          return removeAgentEntry(opts.uid, opts.agentId, String(params.old_text || ''));
        case 'list':
          return listAgentEntries(opts.uid, opts.agentId);
      }
    },
  });

  if (capabilities.has('project.context.write') && opts.projectId) {
    const pid = opts.projectId;
    let instructionsSnapshot = readProjectInstructions(opts.uid, pid);
    const workspace = opts.workingDir || getWorkspacePath(opts.uid, pid);
    Object.assign(methods, {
      project_instructions: async (params: Record<string, unknown>) => {
        if (Object.keys(params).some((key) => key !== 'instructions')
            || typeof params.instructions !== 'string' || !params.instructions.trim()) throw new Error('instructions is required; no scope overrides are accepted');
        const previous = await instructionsSnapshot;
        if (!previous.ok) return previous;
        const result = await writeProjectInstructionsIfUnchanged(opts.uid, pid, previous.content, params.instructions);
        if (result.ok) instructionsSnapshot = Promise.resolve({ ...previous, content: params.instructions });
        return result;
      },
      library_save: async (params: Record<string, unknown>) => {
        if (Object.keys(params).some((key) => !['source_path', 'name', 'action', 'expected_revision'].includes(key))
            || typeof params.source_path !== 'string' || !params.source_path.trim()
            || (params.action !== undefined && params.action !== 'save' && params.action !== 'checkout')
            || (params.expected_revision !== undefined && (typeof params.expected_revision !== 'string' || !params.expected_revision))) throw new Error('invalid library_save fields');
        const source = path.resolve(workspace, params.source_path.trim());
        if (!isPathAllowed(source, [workspace])) throw new Error('source_path must be inside the current workspace');
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        const target = name || path.basename(source);
        if (params.action === 'checkout') {
          if (!name || params.expected_revision !== undefined) throw new Error('checkout requires name and does not accept expected_revision');
          const result = await projectFiles.checkoutProjectFile(opts.uid, pid, name, source);
          return result.ok ? { ...result, path: result.name } : result;
        }
        if (params.expected_revision !== undefined) {
          const result = await projectFiles.replaceProjectFileFromPath(opts.uid, pid, source, target, params.expected_revision as string);
          return result.ok ? { ...result, path: result.name } : result;
        }
        const result = await projectFiles.copyProjectEntryFromPath(opts.uid, pid, source, target);
        return result.ok ? { ok: true, path: result.name, bytes: result.bytes } : result;
      },
    });
  }

  if (capabilities.has('commander.handoff')) Object.assign(methods, {
    'commander.handoff': async (params) => {
      const reason = String(params.reason || '').trim();
      const context = String(params.context || '').trim();
      if (!reason) throw new Error('reason required');
      if (reason.length > 1_000) throw new Error('reason exceeds 1000 characters');
      if (context.length > 6_000) throw new Error('context exceeds 6000 characters');
      const accepted = recordCommanderHandoff({
        reason,
        ...(context ? { context } : {}),
      });
      return accepted
        ? { accepted: true }
        : { accepted: false, already_requested: true };
    },
  });

  return {
    methods,
    preloadSkillDisplayNames: async () => {
      if (capabilities.has('skills.read') || capabilities.has('skills.run')) {
        await listSkills();
      }
    },
    getSkillDisplayName,
  };
}

export async function startBridge(opts: StartBridgeOpts): Promise<BridgeHandle> {
  const token = crypto.randomBytes(24).toString('hex');
  const socketPath = _socketPath(opts.runId);
  // Resolve before opening the host socket so a broken runtime invariant
  // fails without leaking a listener/socket file.
  const backgroundNode = resolveBackgroundNodeRuntime({
    bundledNode: opts.sandboxEnv.ORKAS_BUNDLED_NODE,
  });
  const connectorDisplayNameById = new Map<string, string>();
  const recordConnectorDisplayName = (id: string, name: string): void => {
    const normalizedId = String(id || '').trim();
    const normalizedName = String(name || '').trim();
    if (normalizedId && normalizedName) connectorDisplayNameById.set(normalizedId, normalizedName);
  };
  const capabilities = await _capabilitiesForRun(opts, recordConnectorDisplayName);
  const capabilitySet = new Set(capabilities);
  let closed = false;
  let commanderHandoff: CommanderHandoffRequest | null = null;
  const {
    methods,
    preloadSkillDisplayNames,
    getSkillDisplayName,
  } = _buildMethods(
    opts,
    capabilitySet,
    (request) => {
      if (commanderHandoff) return false;
      commanderHandoff = request;
      return true;
    },
    recordConnectorDisplayName,
    () => !closed,
  );
  if (opts.preloadSkillDisplayNames && capabilitySet.has('skills.read')) {
    try {
      // Prime the same scoped registry before the resumed backend starts so
      // its first Skill event has a stable display name. A failed scan leaves
      // the bridge available and can still recover through a later list/read.
      await preloadSkillDisplayNames();
    } catch (err) {
      log.warn('bridge skill display-name preload failed', {
        ...bridgeLogContext(opts),
        error: logErrorRef(err),
      });
    }
  }

  const sockets = new Set<net.Socket>();
  // Cancellation is scoped to the socket that made the call: request ids are
  // only unique per client process.
  const inflight = new WeakMap<net.Socket, Map<string | number, AbortController>>();
  const inflightFor = (socket: net.Socket): Map<string | number, AbortController> => {
    let calls = inflight.get(socket);
    if (!calls) {
      calls = new Map();
      inflight.set(socket, calls);
    }
    return calls;
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      // A client that died mid-wait can no longer receive the result, so a
      // pending approval must not run its side effect either.
      for (const controller of inflightFor(socket).values()) controller.abort();
      inflight.delete(socket);
    });
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) { socket.destroy(); return; }
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        void handleLine(line, socket).catch(() => { try { socket.destroy(); } catch { /* gone */ } });
      }
    });
    socket.on('error', () => { /* client died mid-run; harmless */ });
  });

  async function handleLine(line: string, socket: net.Socket): Promise<void> {
    let req: { id?: unknown; token?: unknown; method?: unknown; params?: unknown };
    try { req = JSON.parse(line); }
    catch { socket.destroy(); return; }
    const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
    // Constant-shape token check; wrong token = silent close (no oracle).
    // Compare byte lengths (not UTF-16 code-unit lengths) so a multi-byte token
    // can't slip past the length gate and make timingSafeEqual throw RangeError.
    const reqTokenBuf = typeof req.token === 'string' ? Buffer.from(req.token) : null;
    const tokenBuf = Buffer.from(token);
    if (!reqTokenBuf
      || reqTokenBuf.length !== tokenBuf.length
      || !crypto.timingSafeEqual(reqTokenBuf, tokenBuf)) {
      log.warn('bridge auth failure — destroying connection', bridgeLogContext(opts, socketPath));
      socket.destroy();
      return;
    }
    const method = typeof req.method === 'string' ? req.method : '';
    const params = (req.params && typeof req.params === 'object') ? req.params as Record<string, unknown> : {};
    let payload: string;
    if (method === 'connectors.cancel') {
      // Not a registered capability method: it only withdraws this socket's
      // own pending call, so it needs no visibility of its own.
      const callId = typeof params.call_id === 'string' || typeof params.call_id === 'number' ? params.call_id : null;
      const controller = callId === null ? undefined : inflightFor(socket).get(callId);
      controller?.abort();
      payload = JSON.stringify({ id, ok: true, result: { cancelled: !!controller } });
      try { socket.write(payload + '\n'); } catch { /* gone */ }
      return;
    }
    const handler = methods[method];
    if (!handler) {
      payload = JSON.stringify({ id, ok: false, error: `unknown method: ${method}` });
    } else {
      const controller = new AbortController();
      const calls = inflightFor(socket);
      if (id !== null) calls.set(id, controller);
      try {
        const result = await handler(params, { signal: controller.signal });
        payload = JSON.stringify({ id, ok: true, result });
      } catch (err) {
        payload = JSON.stringify({ id, ok: false, error: (err as Error).message || String(err) });
      } finally {
        if (id !== null && calls.get(id) === controller) calls.delete(id);
      }
    }
    try { socket.write(payload + '\n'); } catch { /* gone */ }
  }

  try { fs.unlinkSync(socketPath); } catch { /* none */ }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
  }

  fs.mkdirSync(opts.configDir, { recursive: true });
  const skillOutputDir = capabilities.includes('skills.run')
    ? path.join(opts.configDir, '.orkas-bridge-skill-output')
    : null;
  if (skillOutputDir) {
    fs.mkdirSync(skillOutputDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(skillOutputDir, 0o700); } catch { /* best effort */ }
    }
  }

  // Secret-bearing env lives in a separate 0600 file so Codex `-c`
  // overrides and process-info events never need to serialize it.
  const secretServerEnv: Record<string, string> = withBackgroundNodeEnv({
    ...opts.sandboxEnv,
    ORKAS_UID: opts.uid,
    ORKAS_AGENT_ID: opts.agentId,
    ORKAS_BRIDGE_SOCKET: socketPath,
    ORKAS_BRIDGE_TOKEN: token,
    ORKAS_BRIDGE_CAPABILITIES: capabilities.join(','),
    ...(skillOutputDir ? { ORKAS_BRIDGE_SKILL_OUTPUT_DIR: skillOutputDir } : {}),
  }, backgroundNode);
  const serverEnvFilePath = path.join(opts.configDir, 'orkas-bridge-env.json');
  const serverEnv: Record<string, string> = withBackgroundNodeEnv({
    ORKAS_BRIDGE_ENV_FILE: serverEnvFilePath,
    ...(opts.sandboxEnv.ORKAS_PC_DIR ? { ORKAS_PC_DIR: opts.sandboxEnv.ORKAS_PC_DIR } : {}),
  }, backgroundNode);

  // MCP config file the CLI agent consumes (claude `--mcp-config <path>`).
  const bridgeEntry = path.join(opts.sandboxEnv.ORKAS_PC_DIR || '', 'bin', 'orkas-bridge.cjs');
  const mcpConfig = {
    mcpServers: {
      orkas: {
        command: backgroundNode.executable,
        args: [bridgeEntry],
        env: serverEnv,
      },
    },
  };
  const mcpConfigPath = path.join(opts.configDir, 'orkas-mcp-config.json');
  fs.writeFileSync(serverEnvFilePath, JSON.stringify(secretServerEnv, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(serverEnvFilePath, 0o600); } catch { /* best effort */ }
  }
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

  log.info('bridge started', {
    ...bridgeLogContext(opts, socketPath),
    mcp_config: logPathRef(mcpConfigPath),
    env_file: logPathRef(serverEnvFilePath),
  });

  return {
    socketPath,
    token,
    mcpConfigPath,
    serverEnv,
    capabilities,
    getCommanderHandoff: () => commanderHandoff
      ? { ...commanderHandoff }
      : null,
    getSkillDisplayName,
    getConnectorDisplayName: (id) => connectorDisplayNameById.get(String(id || '').trim()) || null,
    close: async () => {
      closed = true;
      for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') {
        try { fs.unlinkSync(socketPath); } catch { /* gone */ }
      }
      try { fs.unlinkSync(serverEnvFilePath); } catch { /* gone */ }
      if (skillOutputDir) {
        try { fs.rmSync(skillOutputDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      log.info('bridge closed', bridgeLogContext(opts, socketPath));
    },
  };
}
