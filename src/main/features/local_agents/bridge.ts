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
 * Capability surface (decisions I15–I17 in the plan):
 *   - skills.list / skills.read / skills.run_info — trusted + external
 *     package skills, disabled ids filtered; reads/runs are path-checked
 *     against listed skill dirs.
 *   - connectors.list / connectors.call — commander-equivalent visibility
 *     (connected + user-enabled); every call is gated by the
 *     bridge-permissions confirm flow (§D4 launch blocker).
 *   - kb.list / kb.search / kb.read — reuses the in-process KB AgentTools
 *     verbatim, scoped to global + current project when the conversation
 *     belongs to a project.
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
import { listSkillsForBridge, type BridgeSkillRow } from '../../model/core-agent/skill-registry';
import { readDisabledSets } from '../component_enabled';
import { createKbTools } from '../../model/core-agent/kb-tools';
import * as connectors from '../connectors';
import * as bridgePermissions from './bridge_permissions';

const log = createLogger('local-agents:bridge');

const MAX_LINE_BYTES = 1024 * 1024;
const CONNECTOR_RESULT_CAP = 100_000;

export interface BridgeHandle {
  socketPath: string;
  token: string;
  /** Path of the generated MCP config file (claude `--mcp-config`). */
  mcpConfigPath: string;
  /** Non-secret env block used to launch orkas-bridge.cjs. */
  serverEnv: Record<string, string>;
  close(): Promise<void>;
}

export interface StartBridgeOpts {
  uid: string;
  cid: string;
  agentId: string;
  agentName: string;
  /** Current conversation project, if any. Enables project + global Library tools. */
  projectId?: string;
  runId: string;
  /** Where to write the per-run mcp-config file (the persist run dir). */
  configDir: string;
  /** Static skill-sandbox env (ORKAS_NODE / ORKAS_PC_DIR /
   *  ORKAS_WORKSPACE_ROOT / ELECTRON_RUN_AS_NODE plus optional bundled
   *  ORKAS_PYTHON / ORKAS_UV) — reused so the bridge server resolves the
   *  SDK and run-skill.cjs exactly like command execution does. */
  sandboxEnv: Record<string, string>;
}

function _socketPath(runId: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\orkas-bridge-${runId}`;
  // tmpdir keeps the path well under the unix sun_path limit (~104 bytes)
  // — the per-uid data root can be arbitrarily deep.
  return path.join(os.tmpdir(), `orkas-bridge-${runId}.sock`);
}

type BridgeMethod = (params: Record<string, unknown>) => Promise<unknown>;

function _buildMethods(opts: StartBridgeOpts): Record<string, BridgeMethod> {
  // KB tools are reused as-is; map by tool name for dispatch.
  const kbTools = new Map(createKbTools({
    userId: opts.uid,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  }).map((t) => [t.name, t]));
  const runKbTool = async (name: string, params: Record<string, unknown>) => {
    const tool = kbTools.get(name);
    if (!tool) throw new Error(`kb tool unavailable: ${name}`);
    const result = await tool.execute(params, { state: {} } as never);
    const content = result?.content;
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : [])
        .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? c.text || '' : ''))
        .join('\n');
    if (result?.isError) throw new Error(text || 'kb tool failed');
    return { text };
  };

  let skillRowsCache: BridgeSkillRow[] | null = null;
  const listSkills = async (): Promise<BridgeSkillRow[]> => {
    if (skillRowsCache) return skillRowsCache;
    const disabled = readDisabledSets(opts.uid).skills;
    const rows = (await listSkillsForBridge(opts.uid)).filter((r) => !disabled.has(r.id));
    skillRowsCache = rows;
    return rows;
  };

  return {
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

    'skills.run_info': async (params) => {
      const ref = String(params.id || '').trim();
      if (!ref) throw new Error('id required');
      const rows = await listSkills();
      const row = rows.find((r) => r.id === ref) || rows.find((r) => r.name === ref);
      if (!row) throw new Error(`unknown skill: ${ref}`);
      return { id: row.id, name: row.name, source: row.source, dir: row.dir };
    },

    'connectors.list': async () => {
      // Commander-equivalent visibility (agentId undefined → no per-agent
      // whitelist): the per-call permission dialog is the enforcement
      // surface for CLI agents — see plan decision I16.
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

    'kb.search': async (params) => runKbTool('kb_search', params),
    'kb.read': async (params) => runKbTool('kb_read', params),
    'kb.list': async (params) => runKbTool('kb_list', params),
  };
}

export async function startBridge(opts: StartBridgeOpts): Promise<BridgeHandle> {
  const token = crypto.randomBytes(24).toString('hex');
  const socketPath = _socketPath(opts.runId);
  const methods = _buildMethods(opts);

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
      log.warn('bridge auth failure — destroying connection', { runId: opts.runId });
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
  const secretServerEnv: Record<string, string> = {
    ...opts.sandboxEnv,
    ORKAS_UID: opts.uid,
    ORKAS_BRIDGE_SOCKET: socketPath,
    ORKAS_BRIDGE_TOKEN: token,
  };
  const serverEnvFilePath = path.join(opts.configDir, 'orkas-bridge-env.json');
  const serverEnv: Record<string, string> = {
    ORKAS_BRIDGE_ENV_FILE: serverEnvFilePath,
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ORKAS_NODE', 'ORKAS_PC_DIR']) {
    const value = opts.sandboxEnv[key];
    if (value) serverEnv[key] = value;
  }

  // MCP config file the CLI agent consumes (claude `--mcp-config <path>`).
  const bridgeEntry = path.join(opts.sandboxEnv.ORKAS_PC_DIR || '', 'bin', 'orkas-bridge.cjs');
  const mcpConfig = {
    mcpServers: {
      orkas: {
        command: opts.sandboxEnv.ORKAS_NODE || process.execPath,
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

  log.info('bridge started', { runId: opts.runId, socketPath });

  return {
    socketPath,
    token,
    mcpConfigPath,
    serverEnv,
    close: async () => {
      bridgePermissions.cancelForCid(opts.cid);
      for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') {
        try { fs.unlinkSync(socketPath); } catch { /* gone */ }
      }
      try { fs.unlinkSync(serverEnvFilePath); } catch { /* gone */ }
      log.info('bridge closed', { runId: opts.runId });
    },
  };
}
