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
 *     enabled connector; every CLI call is additionally gated by bridge
 *     permissions.
 *   - kb.list / kb.search / kb.read — reuses the in-process KB AgentTools
 *     verbatim, scoped to global + current project when the conversation
 *     belongs to a project.
 *   - chat.search / chat.read — reuses the in-process conversation-history
 *     tools with a host-bound current-only scope and triggering-message bound.
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
import { createKbTools } from '../../model/core-agent/kb-tools';
import { createChatHistoryTools } from '../../model/core-agent/chat-history-tools';
import * as connectors from '../connectors';
import * as bridgePermissions from './bridge_permissions';

const log = createLogger('local-agents:bridge');

const MAX_LINE_BYTES = 1024 * 1024;
const CONNECTOR_RESULT_CAP = 100_000;

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
  close(): Promise<void>;
}

export type BridgeCapability =
  | 'skills.read'
  | 'skills.run'
  | 'connectors'
  | 'kb.read'
  | 'chat.read'
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
  /** Inbound message that triggered this CLI run. Current history stops
   * strictly before it. */
  currentMessageId: string;
  /** Current conversation project, if any. Enables project + global Library tools. */
  projectId?: string;
  runId: string;
  /** Where to write the per-run mcp-config file (the persist run dir). */
  configDir: string;
  /** Static skill-sandbox env (ORKAS_NODE / ORKAS_PC_DIR /
   *  ORKAS_WORKSPACE_ROOT plus bundled runtimes). The bridge replaces the
   *  Electron-flavoured ORKAS_NODE with ORKAS_BUNDLED_NODE so headless helper
   *  launches never inherit the macOS GUI application identity. */
  sandboxEnv: Record<string, string>;
}

function _socketPath(runId: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\orkas-bridge-${runId}`;
  // tmpdir keeps the path well under the unix sun_path limit (~104 bytes)
  // — the per-uid data root can be arbitrarily deep.
  return path.join(os.tmpdir(), `orkas-bridge-${runId}.sock`);
}

type BridgeMethod = (params: Record<string, unknown>) => Promise<unknown>;

const BASE_CAPABILITIES: readonly BridgeCapability[] = [
  'skills.read',
  'skills.run',
  'kb.read',
  'chat.read',
  'commander.handoff',
];

async function _capabilitiesForRun(opts: StartBridgeOpts): Promise<BridgeCapability[]> {
  const capabilities = [...BASE_CAPABILITIES];
  try {
    // Match the ordinary gmember path in core-agent/runner: group-chat Agents
    // share the user's connected + enabled connector set. `enabled_connectors`
    // is authoring/UI metadata and is deliberately not a runtime allowlist.
    const visible = await connectors.resolveVisibleConnectors(opts.uid, undefined);
    if (visible.length) capabilities.push('connectors');
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
): Record<string, BridgeMethod> {
  // Read-only model tools are reused as-is; map by tool name for dispatch.
  const readTools = new Map([
    ...createKbTools({
      userId: opts.uid,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    }),
    ...createChatHistoryTools({
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

  const methods: Record<string, BridgeMethod> = {};

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
      const visible = await connectors.resolveVisibleConnectors(opts.uid, undefined);
      return {
        connectors: visible.map(({ instance, tools }) => ({
          id: instance.id,
          name: instance.display_name,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        })),
      };
    },

    'connectors.call': async (params) => {
      const connectorId = String(params.connector_id || '');
      const toolName = String(params.tool_name || '');
      const args = (params.args && typeof params.args === 'object') ? params.args as Record<string, unknown> : {};
      if (!connectorId || !toolName) throw new Error('connector_id and tool_name required');
      const visible = await connectors.resolveVisibleConnectors(opts.uid, undefined);
      const target = visible.find((v) => v.instance.id === connectorId);
      if (!target) throw new Error(`connector not available: ${connectorId}`);
      if (!target.tools.some((t) => t.name === toolName)) {
        throw new Error(`tool not exposed by connector ${connectorId}: ${toolName}`);
      }

      const allowed = await bridgePermissions.requestPermission({
        uid: opts.uid,
        cid: opts.cid,
        agentId: opts.agentId,
        agentName: opts.agentName,
        connectorId,
        connectorName: target.instance.display_name,
        toolName,
      });
      if (!allowed) {
        throw new Error('E_BRIDGE_PERMISSION_DENIED: the user declined this connector call');
      }

      const raw = await connectors.callTool(opts.uid, connectorId, toolName, args);
      const text = connectors.stringifyMcpResult(raw);
      const capped = text.length > CONNECTOR_RESULT_CAP
        ? `${text.slice(0, CONNECTOR_RESULT_CAP)}\n… [truncated by orkas-bridge at ${CONNECTOR_RESULT_CAP} chars]`
        : text;
      return { text: capped };
    },
  });

  if (capabilities.has('kb.read')) Object.assign(methods, {
    'kb.search': async (params) => runReadTool('kb_search', params),
    'kb.read': async (params) => runReadTool('kb_read', params),
    'kb.list': async (params) => runReadTool('kb_list', params),
  });

  if (capabilities.has('chat.read')) Object.assign(methods, {
    'chat.search': async (params) => runReadTool('chat_search', params),
    'chat.read': async (params) => runReadTool('chat_read', params),
  });

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

  return methods;
}

export async function startBridge(opts: StartBridgeOpts): Promise<BridgeHandle> {
  const token = crypto.randomBytes(24).toString('hex');
  const socketPath = _socketPath(opts.runId);
  // Resolve before opening the host socket so a broken runtime invariant
  // fails without leaking a listener/socket file.
  const backgroundNode = resolveBackgroundNodeRuntime({
    bundledNode: opts.sandboxEnv.ORKAS_BUNDLED_NODE,
  });
  const capabilities = await _capabilitiesForRun(opts);
  const capabilitySet = new Set(capabilities);
  let commanderHandoff: CommanderHandoffRequest | null = null;
  const methods = _buildMethods(opts, capabilitySet, (request) => {
    if (commanderHandoff) return false;
    commanderHandoff = request;
    return true;
  });

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
    const handler = methods[method];
    let payload: string;
    if (!handler) {
      payload = JSON.stringify({ id, ok: false, error: `unknown method: ${method}` });
    } else {
      try {
        const result = await handler((req.params && typeof req.params === 'object') ? req.params as Record<string, unknown> : {});
        payload = JSON.stringify({ id, ok: true, result });
      } catch (err) {
        payload = JSON.stringify({ id, ok: false, error: (err as Error).message || String(err) });
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

  // Secret-bearing env lives in a separate 0600 file so Codex `-c`
  // overrides and process-info events never need to serialize it.
  const secretServerEnv: Record<string, string> = withBackgroundNodeEnv({
    ...opts.sandboxEnv,
    ORKAS_UID: opts.uid,
    ORKAS_AGENT_ID: opts.agentId,
    ORKAS_BRIDGE_SOCKET: socketPath,
    ORKAS_BRIDGE_TOKEN: token,
    ORKAS_BRIDGE_CAPABILITIES: capabilities.join(','),
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
  fs.mkdirSync(opts.configDir, { recursive: true });
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
    close: async () => {
      bridgePermissions.cancelForCid(opts.cid);
      for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') {
        try { fs.unlinkSync(socketPath); } catch { /* gone */ }
      }
      try { fs.unlinkSync(serverEnvFilePath); } catch { /* gone */ }
      log.info('bridge closed', bridgeLogContext(opts, socketPath));
    },
  };
}
