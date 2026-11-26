/**
 * IPC handlers for local CLI agent discovery.
 *
 * Logical channels exposed to the renderer:
 *   - `localAgents.list`             → all known CLI types with availability + version
 *                                      (`validate:false` does path-only discovery)
 *   - `localAgents.detect`           → single-CLI re-probe (bypasses cache;
 *                                      callers may run types concurrently)
 *   - `localAgents.runtimeOptions`   → Agent-scoped model/thinking/permission metadata
 *   - `localAgents.readToolResult`   → read a spilled CLI tool_result file
 *                                       (renderer click-to-expand)
 *   - `localAgents.permissionResponse` → renderer answer to an external CLI's
 *                                         native or connector permission request
 *   - `localAgents.userInputResponse`  → renderer answer to a native CLI's
 *                                         structured in-turn question
 *
 * No `run` channel here — the renderer doesn't spawn CLIs directly;
 * dispatch goes through the existing `groupChat` channel and `bus.ts`
 * routes CLI agents into `features/local_agents/runner.ts` (Step 6).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import {
  detectAll,
  findAllInstalled,
  localCliSupportsPermissionPolicy,
  resolveCli,
  LOCAL_CLI_TYPES,
  type LocalCliPermissionPolicy,
  type LocalCliType,
} from '../features/local_agents/registry.js';
import { getCliUpgradeInfo, upgradeLocalCli } from '../features/local_agents/upgrade.js';
import { getLocalCliRuntimeOptions } from '../features/local_agents/runtime_options.js';
import { getLocalCliAccountUsage } from '../features/local_agents/account_usage.js';
import * as agents from '../features/agents.js';
import * as cliPermissions from '../features/local_agents/cli_permissions.js';
import * as cliUserInput from '../features/local_agents/cli_user_input.js';
import type { LocalCliPermissionDecision } from '../features/local_agents/backends/base.js';
import * as bashPermissions from '../model/core-agent/bash-permissions.js';
import {
  closeInteractiveCliSession,
  listInteractiveCliSessions,
  readInteractiveCliSession,
  sendInteractiveCliInput,
} from '../model/core-agent/interactive-cli-sessions.js';
import { getActiveUserId } from '../features/users.js';
import { userConversationHistoryCacheDir, userToolResultsDir } from '../paths.js';
import { createLogger } from '../logger.js';
import { logErrorRef, logPathRef, maskId } from '../util/log-redact.js';

const log = createLogger('ipc:local_agents');

/** Each explicit disclosure reads at most 256 KiB; continuation byte cursors
 * never split UTF-8 characters. Existing head-only callers remain compatible. */
const READ_TOOL_RESULT_MAX_BYTES = 256 * 1024;
const TOOL_RESULT_REF_RE = /^[A-Za-z0-9_-]{1,48}\.[a-f0-9]{16,64}$/i;
const UPGRADE_PROGRESS_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function resolveToolResultRef(rootDir: string, ref: string): string | null {
  if (!TOOL_RESULT_REF_RE.test(ref)) return null;
  const fileName = `${ref}.txt`;
  const direct = path.join(rootDir, fileName);
  if (fs.existsSync(direct)) return direct;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isLocalCliType(v: unknown): v is LocalCliType {
  return typeof v === 'string' && (LOCAL_CLI_TYPES as readonly string[]).includes(v);
}

function isActivePermissionOwner(uid: string): boolean {
  try { return getActiveUserId() === uid; }
  catch { return false; }
}

async function upgradeTarget(payload: { type?: unknown; agent_id?: unknown }): Promise<LocalCliType> {
  if (payload.agent_id !== undefined) {
    if (!agents.isValidAgentId(payload.agent_id)) throw new Error('invalid agent_id');
    const agent = await agents.getAgent(String(payload.agent_id));
    if (agent?.runtime?.kind !== 'cli' || !isLocalCliType(agent.runtime.cli)) throw new Error('invalid CLI Agent');
    return agent.runtime.cli;
  }
  if (!isLocalCliType(payload.type)) throw new Error('invalid CLI type');
  return payload.type;
}

export const invokeHandlers = {
  'localAgents.accountUsage': async (
    { agent_id, force = false }: { agent_id?: unknown; force?: unknown },
    ctx: { userId: string },
  ) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const agent = await agents.getAgent(String(agent_id));
    if (!agent || agent.runtime?.kind !== 'cli' || !isLocalCliType(agent.runtime.cli)) {
      throw new Error('agent is not backed by a supported CLI');
    }
    const cli = agent.runtime.cli;
    const [entries, projectDir] = await Promise.all([
      detectAll(), agents.getAgentCliProjectDirInfo(ctx.userId, agent.agent_id),
    ]);
    const entry = entries.find(candidate => candidate.type === cli);
    if (!entry) throw new Error('CLI entry not found');
    return { usage: await getLocalCliAccountUsage(ctx.userId, entry, projectDir?.effective_path || process.cwd(), {
      force: force === true, customArgs: agent.runtime.custom_args || [],
    }) };
  },
  'localAgents.upgradeInfo': async (payload: { type?: unknown; agent_id?: unknown }) =>
    getCliUpgradeInfo(await upgradeTarget(payload)),
  'localAgents.upgrade': async (
    payload: { type?: unknown; agent_id?: unknown; progress_id?: unknown },
    ctx?: { sender: Pick<WebContents, 'send' | 'isDestroyed'> },
  ) => {
    const type = await upgradeTarget(payload);
    const { progress_id: progressId } = payload;
    const sender = ctx?.sender;
    if (!sender || typeof progressId !== 'string' || !UPGRADE_PROGRESS_ID_RE.test(progressId)) {
      return upgradeLocalCli(type);
    }
    return upgradeLocalCli(type, ({ phase, elapsed_ms }) => {
      if (!sender.isDestroyed()) sender.send('local-agent:upgrade-progress', { progress_id: progressId, phase, elapsed_ms });
    });
  },

  /**
   * List all known CLI types. Default runs version validation and uses the
   * process-lifetime cache; pass `{ force: true }` to refresh it. The
   * External-agent create panel first requests `{ validate:false }`, which
   * performs only executable-path discovery and never starts a CLI process.
   */
  'localAgents.list': async (
    { force = false, validate = true }: { force?: boolean; validate?: boolean } = {},
  ) => {
    const entries = validate === false
      ? await findAllInstalled()
      : await detectAll({ force: !!force });
    return { entries };
  },

  /**
   * Refresh one CLI for the create modal. If startup warmup is already probing
   * this type, the request joins that work; otherwise it invalidates only this
   * type and starts its independent version probe.
   */
  'localAgents.detect': async ({ type }: { type?: unknown }) => {
    if (!isLocalCliType(type)) throw new Error('invalid CLI type');
    const entry = await resolveCli(type, { force: true });
    return { entry };
  },

  /**
   * Resolve only the selected Agent's configured CLI and effective cwd, then
   * return sanitized model/thinking metadata. The renderer cannot probe an
   * arbitrary executable or directory through this channel.
   */
  'localAgents.runtimeOptions': async (
    { agent_id, force = false }: { agent_id?: unknown; force?: unknown },
    ctx: { userId: string },
  ) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const agent = await agents.getAgent(String(agent_id));
    if (!agent) throw new Error('agent not found');
    if (agent.runtime?.kind !== 'cli' || !isLocalCliType(agent.runtime.cli)) {
      throw new Error('agent is not backed by a supported CLI');
    }
    const cli = agent.runtime.cli;
    const [entries, projectDir] = await Promise.all([
      detectAll(),
      agents.getAgentCliProjectDirInfo(ctx.userId, agent.agent_id),
    ]);
    const entry = entries.find(candidate => candidate.type === cli);
    if (!entry) throw new Error('CLI entry not found');
    const cwd = projectDir?.effective_path || process.cwd();
    const options = await getLocalCliRuntimeOptions(entry, cwd, {
      force: force === true,
      customArgs: agent.runtime.custom_args || [],
    });
    const observedModel = agents.getAgentCliResolvedModelInfo(ctx.userId, agent.agent_id);
    return {
      options: {
        ...options,
        ...(observedModel?.cli === cli ? { last_resolved_model: observedModel } : {}),
      },
    };
  },

  /**
   * Read a spilled CLI tool_result file. The renderer's click-to-expand
   * UI calls this with the opaque `outputRef` it received on a `tool-event
   * phase:'result'` event. A legacy absolute `path` remains accepted for old
   * local transcripts, but new cloud-synced events never carry it.
   *
   * Hard constraints:
   *   - Path MUST resolve under the active uid's
   *     `<uid>/local/tool-results/` directory. Symlink-traversal is
   *     blocked by realpath-comparing against the canonical root, so a
   *     compromised CLI can't trick the renderer into reading
   *     arbitrary files.
   *   - Read is byte-capped (256 KB inline); larger files truncate
   *     and set `truncated: true`. The shell.openPath path for "open
   *     in editor" is a separate IPC, not added in this round.
   *
   * Returns `{ok:true, content, truncated}` or `{ok:false, error}`;
   * never throws across the IPC boundary so a UI bug can't crash the
   * renderer.
   */
  /** Renderer answer to an external CLI's native or connector approval request. */
  'localAgents.permissionResponse': async (
    payload: { request_id?: unknown; decision?: unknown; permission_policy?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    const decision = payload.decision;
    if (decision !== 'allow_once' && decision !== 'allow_run' && decision !== 'deny') {
      throw new Error('invalid decision');
    }
    const pending = cliPermissions.beginResponse(payload.request_id, ctx.userId);
    if (!pending) return { handled: false };

    const selectedPolicy = typeof payload.permission_policy === 'string'
      ? payload.permission_policy
      : pending.permissionPolicy;
    let effectiveDecision: LocalCliPermissionDecision = decision;
    let policySaved = true;
    if (!isActivePermissionOwner(pending.uid)) {
      effectiveDecision = 'deny';
      policySaved = false;
    } else if (!localCliSupportsPermissionPolicy(pending.cli, selectedPolicy)) {
      effectiveDecision = 'deny';
      policySaved = false;
    } else if (decision !== 'deny' && selectedPolicy !== pending.permissionPolicy) {
      try {
        const agent = await agents.getAgent(pending.agentId);
        if (!isActivePermissionOwner(pending.uid)
          || agent?.runtime?.kind !== 'cli'
          || agent.runtime.cli !== pending.cli) {
          policySaved = false;
        } else {
          const nextRuntime = { ...agent.runtime };
          if (selectedPolicy === 'inherit') delete nextRuntime.permission_policy;
          else nextRuntime.permission_policy = selectedPolicy as Exclude<LocalCliPermissionPolicy, 'inherit'>;
          const saved = await agents.updateAgentSpec(pending.agentId, { runtime: nextRuntime });
          policySaved = isActivePermissionOwner(pending.uid)
            && saved?.runtime?.kind === 'cli'
            && saved.runtime.cli === pending.cli
            && (saved.runtime.permission_policy || 'inherit') === selectedPolicy;
        }
      } catch (error) {
        policySaved = false;
        log.warn('external CLI permission policy update failed', {
          agent_id: maskId(pending.agentId),
          cli: pending.cli,
          error: logErrorRef(error),
        });
      }
      if (!policySaved) effectiveDecision = 'deny';
    }
    // A user switch cancels pending requests. Recheck after any disk write so
    // a response from the old renderer can never grant authority in the new
    // account, even if the switch landed while persistence was in flight.
    if (!isActivePermissionOwner(pending.uid)) {
      effectiveDecision = 'deny';
      policySaved = false;
    }
    if (effectiveDecision !== 'deny' && policySaved) {
      cliPermissions.updateActiveAgentPermissionPolicy({
        uid: pending.uid,
        agentId: pending.agentId,
        cli: pending.cli,
        permissionPolicy: selectedPolicy as LocalCliPermissionPolicy,
      });
    }
    // The native process started under its previous policy. A newly selected
    // full-access level therefore grants the remaining host task as well;
    // native responses stay bounded to one operation.
    if (effectiveDecision !== 'deny' && selectedPolicy === 'full_access') {
      effectiveDecision = 'allow_run';
    }
    return {
      ...cliPermissions.respond(payload.request_id, effectiveDecision),
      policy_saved: policySaved,
      permission_policy: selectedPolicy,
    };
  },

  /** A non-blocking question replies to its original live CLI turn. */
  'localAgents.asyncInputResponse': async (
    payload: { cid?: unknown; message_id?: unknown; answers?: unknown; cancelled?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.cid !== 'string' || typeof payload?.message_id !== 'string') {
      throw new Error('invalid question identity');
    }
    const group = await import('../features/group_chat');
    return group.submitCliAsyncInput(ctx.userId, payload.cid, payload.message_id, payload.answers, payload.cancelled === true);
  },

  /** Renderer answer to a native CLI structured user-input request. */
  'localAgents.userInputResponse': async (
    payload: { request_id?: unknown; answers?: unknown; cancelled?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) {
      throw new Error('invalid request_id');
    }
    if (payload.answers !== undefined
        && (!payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers))) {
      throw new Error('invalid answers');
    }
    if (payload.cancelled === true) return cliUserInput.cancelRequest(payload.request_id, ctx.userId);
    return cliUserInput.respond(
      payload.request_id,
      ctx.userId,
      payload.answers,
      payload.cancelled === true,
    );
  },

  /** Renderer answer to a `bash:permission` push event (sensitive approval modes).
   *  `decision` ∈ allow_once | allow_run | deny. Unknown / timed-out ids
   *  return handled:false (stale dialog). Verdict semantics live in
   *  model/core-agent/bash-permissions.ts. */
  'bash.permission_response': async (
    payload: { request_id?: unknown; decision?: unknown },
  ) => {
    if (typeof payload?.request_id !== 'string' || !payload.request_id) throw new Error('invalid request_id');
    const d = payload.decision;
    if (d !== 'allow_once' && d !== 'allow_run' && d !== 'deny') throw new Error('invalid decision');
    const handled = bashPermissions.respond(payload.request_id, d);
    return { handled };
  },

  'interactiveCli.list': async (_payload: unknown, ctx: { userId: string }) => {
    return { sessions: listInteractiveCliSessions(ctx.userId) };
  },

  'interactiveCli.read': async (
    payload: { session_id?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    return { session: readInteractiveCliSession(ctx.userId, payload.session_id) };
  },

  'interactiveCli.send': async (
    payload: { session_id?: unknown; input?: unknown; add_newline?: unknown; sensitive?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    const text = typeof payload.input === 'string' ? payload.input : '';
    const session = sendInteractiveCliInput(ctx.userId, payload.session_id, text, {
      addNewline: payload.add_newline !== false,
      sensitive: payload.sensitive === true,
    });
    return { session };
  },

  'interactiveCli.close': async (
    payload: { session_id?: unknown },
    ctx: { userId: string },
  ) => {
    if (typeof payload?.session_id !== 'string' || !payload.session_id) throw new Error('invalid session_id');
    return { session: closeInteractiveCliSession(ctx.userId, payload.session_id) };
  },

  'localAgents.readToolResult': async (
    { path: legacyPath, ref, cursor = 0 }: { path?: unknown; ref?: unknown; cursor?: unknown },
  ) => {
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) return { ok: false as const, error: 'invalid result cursor' };
    const uid = (() => {
      try { return getActiveUserId(); }
      catch { return ''; }
    })();
    if (!uid) return { ok: false as const, error: 'no active user' };
    const rootDir = userToolResultsDir(uid);
    const historyCacheRootDir = userConversationHistoryCacheDir(uid);
    let filePath = '';
    if (typeof ref === 'string' && ref) {
      if (!TOOL_RESULT_REF_RE.test(ref)) {
        return { ok: false as const, error: 'invalid result ref' };
      }
      filePath = resolveToolResultRef(rootDir, ref) || '';
      if (!filePath) return { ok: false as const, error: 'file no longer exists' };
    } else if (typeof legacyPath === 'string' && legacyPath) {
      filePath = legacyPath;
    } else {
      return { ok: false as const, error: 'invalid result ref' };
    }
    // Resolve both sides via realpath when they exist, then compare.
    // The renderer-supplied path may legitimately not exist anymore
    // (sweep ran, tool-result evicted) — handle ENOENT cleanly.
    let resolved: string;
    try {
      resolved = fs.realpathSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false as const, error: 'file no longer exists' };
      return { ok: false as const, error: `cannot resolve path: ${(err as Error).message}` };
    }
    let insideAllowedRoot = false;
    try {
      const rootResolved = fs.realpathSync(rootDir);
      const rel = path.relative(rootResolved, resolved);
      insideAllowedRoot = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } catch { /* local result store is optional */ }
    if (!insideAllowedRoot) {
      try {
        const historyRootResolved = fs.realpathSync(historyCacheRootDir);
        const rel = path.relative(historyRootResolved, resolved);
        const segments = rel.split(path.sep);
        // Only `<cache>/<entry>/tool-results/<file>` is readable. The sibling
        // projected messages/meta files and every other clearable cache bucket
        // remain outside this IPC capability.
        insideAllowedRoot = !rel.startsWith('..')
          && !path.isAbsolute(rel)
          && segments.length === 3
          && segments[1] === 'tool-results';
      } catch { /* history cache is optional */ }
    }
    if (!insideAllowedRoot) {
      log.warn('readToolResult rejected out-of-scope path', {
        path: logPathRef(filePath),
        user_id: maskId(uid),
      });
      return { ok: false as const, error: 'path is outside tool-results scope' };
    }
    try {
      // A FIFO must not block main before descriptor-level type validation.
      const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return { ok: false as const, error: 'not a regular file' };
        const position = cursor as number;
        if (position > stat.size) return { ok: false as const, error: 'invalid result cursor' };
        const buf = Buffer.alloc(Math.min(READ_TOOL_RESULT_MAX_BYTES, stat.size - position));
        let read = 0;
        while (read < buf.length) {
          const count = fs.readSync(fd, buf, read, buf.length - read, position + read);
          if (!count) throw new Error('Result page unavailable');
          read += count;
        }
        if (read && (buf[0] & 0xc0) === 0x80) return { ok: false as const, error: 'invalid result cursor' };
        if (position + read < stat.size) {
          // Drop only an incomplete trailing character, then reread it whole.
          let lead = read - 1;
          while (lead >= 0 && (buf[lead] & 0xc0) === 0x80) lead--;
          if (lead >= 0) {
            const byte = buf[lead];
            const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
            if (read - lead < length) read = lead;
          }
        }
        const next_cursor = position + read < stat.size ? position + read : null;
        return { ok: true as const, content: buf.toString('utf8', 0, read), truncated: next_cursor !== null, next_cursor };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  },
};
