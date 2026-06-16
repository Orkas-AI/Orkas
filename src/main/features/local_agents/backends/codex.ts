/**
 * Codex CLI backend — talks the `codex app-server --listen stdio://`
 * JSON-RPC 2.0 protocol. Modelled after multica's `codex.go`, distilled
 * to what we need for one-shot agent dispatch:
 *
 *  1. Spawn `codex app-server --listen stdio://`.
 *  2. RPC `initialize` (clientInfo + experimentalApi capability).
 *  3. Notify `initialized`.
 *  4. RPC `thread/start` (or `thread/resume` if we have a prior thread)
 *     → `result.threadId`.
 *  5. RPC `turn/start` with `{threadId, input:[{type:"text", text:prompt}]}`.
 *  6. Listen for notifications until the turn ends:
 *     - `codex/event` (params is an event object with `type`):
 *         task_started / agent_message / exec_command_begin/end /
 *         patch_apply_begin/end / task_complete / turn_aborted
 *     - `turn/started` / `turn/completed` (top-level v2 lifecycle)
 *     - `error` (top-level transport error; non-retry → terminal)
 *  7. Close stdin → codex exits cleanly.
 *
 * Notifications carry `threadId`; codex multiplexes subagent threads
 * (memory consolidation, etc.) on the same stdio pipe. We filter to
 * our own threadId to avoid surfacing unrelated chatter.
 *
 * Resume: when `opts.resumeSessionId` is set, we attempt
 * `thread/resume` first; on any failure we fall back to a fresh
 * `thread/start` so the user's task still runs (matching multica).
 */

import { createLogger } from '../../../logger.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  type LocalEvent,
  StderrTail,
  spawnCli,
  bindAbort,
  armKillWatchdog,
  LineSplitter,
} from './base.js';

/** codex notifications that are pure metadata noise — we keep them
 *  visible only at level=debug. Everything outside this list AND
 *  outside the structured handlers above falls through to a level=info
 *  log event so users see what the binary is up to. usage notifications
 *  are intentionally OUT of this list because step 6 promotes them to
 *  a structured `status:'usage'` event with live counters. */
const CODEX_DROP_TO_DEBUG = new Set<string>([
  'thread/started',
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
]);

const log = createLogger('local-agents:codex');

const TRUSTED_LOCAL_APPROVAL_POLICY = 'never';
const TRUSTED_LOCAL_SANDBOX_MODE = 'danger-full-access';
const TRUSTED_LOCAL_SANDBOX_POLICY = { type: 'dangerFullAccess' } as const;

export const codexBackend: LocalBackend = {
  async run(opts: BackendRunOptions): Promise<void> {
    const args = buildCodexArgs(opts);
    const childEnv = opts.bridge?.server.env ? { ...process.env, ...opts.bridge.server.env } : process.env;
    const child = spawnCli(opts.binPath, args, opts.cwd, childEnv);
    const detachAbort = bindAbort(child, opts.signal);
    const tail = new StderrTail();
    const startedAt = Date.now();

    let exited = false;
    let resolveOuter!: () => void;
    const outerPromise = new Promise<void>(resolve => { resolveOuter = resolve; });

    opts.onEvent({
      type: 'process-info',
      pid: child.pid ?? -1,
      cwd: opts.cwd,
      cmd: opts.binPath,
      args,
    });

    const watchdog = armKillWatchdog(child, {
      timeoutMs: opts.timeoutMs,
      idleKillMs: opts.idleKillMs,
      lastEventAt: opts.lastEventAt,
    });

    // ─── JSON-RPC client state ────────────────────────────────────────
    let nextRpcId = 1;
    const pending = new Map<number, { method: string; resolve: (r: any) => void; reject: (e: Error) => void }>();
    let threadId: string | undefined;
    let turnStarted = false;
    let turnAborted = false;
    let turnCompleted = false;
    const seenTurnIds = new Set<string>();
    let collectedText = '';
    let turnError: string | undefined;
    // Latest usage snapshot from `thread/tokenUsage/updated` —
    // each notification is a cumulative state (not an increment),
    // so we just overwrite. Threaded into the done event below.
    let lastUsage: Record<string, number | string> | undefined;

    const sendLine = (msg: object) => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); }
      catch (err) { log.warn('codex stdin write failed', { error: (err as Error).message }); }
    };

    const rpc = (method: string, params: Record<string, unknown>): Promise<any> =>
      new Promise<any>((resolve, reject) => {
        const id = nextRpcId++;
        pending.set(id, { method, resolve, reject });
        sendLine({ jsonrpc: '2.0', id, method, params });
      });

    const notify = (method: string, params?: Record<string, unknown>) => {
      sendLine({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    };

    const closePending = (err: Error) => {
      for (const { reject } of pending.values()) reject(err);
      pending.clear();
    };

    // ─── stdout JSON-RPC framing ─────────────────────────────────────
    const splitter = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk, line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let env: any;
        try { env = JSON.parse(trimmed); }
        catch {
          // codex stdout is supposed to be pure JSON-RPC; a non-JSON
          // line here means the binary logged something directly to
          // stdout (rare, but diagnostic-worthy when it happens — we
          // were swallowing these before).
          opts.onEvent({ type: 'raw-line', line: trimmed });
          return;
        }
        // Response (matches a pending request by id).
        if (env && typeof env.id === 'number' && pending.has(env.id)) {
          const p = pending.get(env.id)!;
          pending.delete(env.id);
          if (env.error) {
            p.reject(new Error(`${p.method}: ${env.error.message || 'rpc error'} (code=${env.error.code ?? 0})`));
          } else {
            p.resolve(env.result);
          }
          return;
        }
        // Notification (no id, has method).
        if (env && typeof env.method === 'string') {
          handleNotification(env.method, env.params || {});
        }
      });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail.push(chunk);
      for (const line of chunk.split(/\r?\n/)) {
        if (line) opts.onEvent({ type: 'stderr-line', line });
      }
    });

    function emitTextDelta(text: string) {
      if (!text) return;
      collectedText += text;
      opts.onEvent({ type: 'text-delta', text });
    }

    // Codex 0.125+ uses fine-grained notifications:
    //   thread/started, thread/status/changed, thread/tokenUsage/updated
    //   turn/started, turn/completed
    //   item/started, item/completed (with item.type: userMessage,
    //     agentMessage, agentReasoning, commandExecution, ...)
    //   item/agentMessage/delta (params.delta is the streamed text chunk)
    //   account/rateLimits/updated, mcpServer/startupStatus/updated (noise)
    // Older codex (per multica) used `codex/event` notifications wrapping
    // events with type:task_started/agent_message/etc — we keep a
    // best-effort handler for that shape too in case older codex builds
    // are encountered.
    function handleNotification(method: string, params: Record<string, any>) {
      const eventThreadId = typeof params.threadId === 'string' ? params.threadId : '';
      if (threadId && eventThreadId && eventThreadId !== threadId) return;

      // ── Streaming agent text (the important one) ─────────────────
      if (method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) emitTextDelta(delta);
        return;
      }

      // ── Lifecycle ────────────────────────────────────────────────
      if (method === 'turn/started') {
        turnStarted = true;
        opts.onEvent({ type: 'status', status: 'running' });
        return;
      }
      if (method === 'turn/completed') {
        const turn = params?.turn || {};
        const turnId: string = typeof turn?.id === 'string' ? turn.id : '';
        const status: string = typeof turn?.status === 'string' ? turn.status : '';
        if (turnId && seenTurnIds.has(turnId)) return;
        if (turnId) seenTurnIds.add(turnId);
        if (status === 'failed') {
          turnError = (turn?.error?.message && String(turn.error.message)) || 'codex turn failed';
        }
        const aborted = status === 'cancelled' || status === 'canceled'
                     || status === 'aborted' || status === 'interrupted';
        finishTurn(aborted);
        return;
      }

      // ── item/* — surface tool-equivalent events; fallback final text ──
      if (method === 'item/started') {
        const item = params.item || {};
        if (item.type === 'commandExecution') {
          opts.onEvent({
            type: 'tool-event',
            tool: 'exec_command',
            callId: String(item.id || ''),
            phase: 'use',
            input: { command: item.command || item.script || '' },
          });
        } else if (item.type === 'fileChange' || item.type === 'patchApply') {
          opts.onEvent({
            type: 'tool-event',
            tool: 'patch_apply',
            callId: String(item.id || ''),
            phase: 'use',
          });
        } else if (item.type === 'agentReasoning') {
          // Reasoning chunks — surface as thinking. Some codex versions
          // include text directly on item.text, others stream via a
          // dedicated reasoning/delta we don't see today.
          const text = typeof item.text === 'string' ? item.text : '';
          if (text) opts.onEvent({ type: 'thinking', text });
        }
        return;
      }
      if (method === 'item/completed') {
        const item = params.item || {};
        if (item.type === 'commandExecution') {
          opts.onEvent({
            type: 'tool-event',
            tool: 'exec_command',
            callId: String(item.id || ''),
            phase: 'result',
            output: typeof item.output === 'string' ? item.output : (item.aggregatedOutput ?? ''),
          });
        } else if (item.type === 'fileChange' || item.type === 'patchApply') {
          opts.onEvent({
            type: 'tool-event',
            tool: 'patch_apply',
            callId: String(item.id || ''),
            phase: 'result',
          });
        } else if (item.type === 'agentMessage') {
          // Fallback when delta-streaming didn't fire: emit the final
          // text once. We compare against what we already collected
          // to avoid duplication.
          const text = typeof item.text === 'string' ? item.text : '';
          if (text && !collectedText.includes(text)) emitTextDelta(text);
        }
        return;
      }

      // ── Top-level error ──────────────────────────────────────────
      if (method === 'error') {
        const willRetry = !!params.willRetry;
        const errMsg = (params.error?.message && String(params.error.message))
                    || (typeof params.message === 'string' ? params.message : '');
        if (errMsg && !willRetry) turnError = errMsg;
        return;
      }

      // ── Idle fallback when turn/completed never arrives ─────────
      if (method === 'thread/status/changed') {
        const statusType = params?.status?.type;
        if (statusType === 'idle' && turnStarted) finishTurn(false);
        return;
      }

      // ── Token-usage streaming pulse ─────────────────────────────
      // codex 0.125+ emits this notification through a turn whenever
      // the cumulative token count advances. Strongest 'still alive'
      // signal short of actual text — surface as a status:'usage'
      // event the rail can render as a live counter row, and stash
      // the latest value for the terminal done event.
      if (method === 'thread/tokenUsage/updated') {
        const u = extractCodexUsage(params);
        if (u) {
          lastUsage = u;
          opts.onEvent({ type: 'status', status: 'usage', usage: u });
        }
        return;
      }

      if (method === 'turn/diff/updated') {
        const files = extractCodexDiffFiles(typeof params?.diff === 'string' ? params.diff : '');
        if (files.length) opts.onEvent({ type: 'file-change', paths: files });
        opts.onEvent({
          type: 'log',
          level: 'debug',
          message: `turn/diff/updated: ${files.join(', ') || 'diff updated'}`,
          source: 'codex',
        });
        return;
      }

      // ── Legacy codex/event protocol (older codex builds) ─────────
      if (method === 'codex/event' || method.startsWith('codex/event/')) {
        const ev = (params && typeof params === 'object' && typeof params.type === 'string')
          ? params
          : (params?.msg && typeof params.msg === 'object' ? params.msg : null);
        if (ev) handleLegacyCodexEvent(ev);
        return;
      }

      // Anything else — surface as a log event. Bucketed noise
      // (CODEX_DROP_TO_DEBUG) goes at level=debug so it's visible only
      // with ORKAS_LOG_LEVEL=debug; everything genuinely unknown goes
      // at level=info so users see what the binary is doing instead
      // of staring at a quiet rail. Trimmed to keep rail rows short.
      const lvl: 'debug' | 'info' = CODEX_DROP_TO_DEBUG.has(method) ? 'debug' : 'info';
      const summary = JSON.stringify(params || {}).slice(0, 200);
      opts.onEvent({
        type: 'log',
        level: lvl,
        message: `${method}: ${summary}`,
        source: 'codex',
      });
    }

    function handleLegacyCodexEvent(ev: Record<string, any>) {
      switch (ev.type) {
        case 'task_started':
          turnStarted = true;
          opts.onEvent({ type: 'status', status: 'running' });
          return;
        case 'agent_message': {
          const text = typeof ev.message === 'string' ? ev.message : '';
          emitTextDelta(text);
          return;
        }
        case 'agent_message_delta': {
          const text = typeof ev.delta === 'string' ? ev.delta
                     : (typeof ev.message === 'string' ? ev.message : '');
          emitTextDelta(text);
          return;
        }
        case 'exec_command_begin':
          opts.onEvent({
            type: 'tool-event', tool: 'exec_command',
            callId: String(ev.call_id || ev.callId || ''),
            phase: 'use', input: { command: ev.command },
          });
          return;
        case 'exec_command_end':
          opts.onEvent({
            type: 'tool-event', tool: 'exec_command',
            callId: String(ev.call_id || ev.callId || ''),
            phase: 'result', output: typeof ev.output === 'string' ? ev.output : '',
          });
          return;
        case 'patch_apply_begin':
          opts.onEvent({ type: 'tool-event', tool: 'patch_apply', callId: String(ev.call_id || ev.callId || ''), phase: 'use' });
          return;
        case 'patch_apply_end':
          opts.onEvent({ type: 'tool-event', tool: 'patch_apply', callId: String(ev.call_id || ev.callId || ''), phase: 'result' });
          return;
        case 'task_complete':
          finishTurn(false);
          return;
        case 'turn_aborted':
          turnAborted = true;
          finishTurn(true);
          return;
      }
    }

    function finishTurn(aborted: boolean) {
      if (turnCompleted) return;
      turnCompleted = true;
      if (aborted) turnAborted = true;
      // Close stdin so codex shuts down cleanly. The `close` handler
      // below resolves the outer promise once the process exits.
      try { child.stdin.end(); } catch { /* */ }
    }

    function finish(status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Record<string, unknown> = {}) {
      if (exited) return;
      exited = true;
      watchdog.disarm();
      detachAbort();
      closePending(new Error('codex shutting down'));
      opts.onEvent({
        type: 'done', status,
        durationMs: Date.now() - startedAt,
        sessionId: threadId,
        ...(lastUsage ? { usage: lastUsage } : {}),
        ...extra,
      });
      resolveOuter();
    }

    child.on('error', err => {
      log.warn('codex spawn error', { error: (err as Error).message });
      finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
    });
    child.on('close', code => {
      if (opts.signal.aborted) return finish('cancelled', { output: collectedText });
      if (watchdog.fired()) return finish('timeout', { error: `cli ${watchdog.reason()}`, output: collectedText, stderrTail: tail.toString() });
      if (turnAborted) return finish('cancelled', { output: collectedText });
      if (turnError) return finish('failed', { error: turnError, output: collectedText, stderrTail: tail.toString() });
      if (code === 0 && (turnCompleted || collectedText)) {
        return finish('completed', { output: collectedText });
      }
      finish('failed', {
        error: `codex exited with code ${code}` + (turnCompleted ? '' : ' (turn never completed)'),
        output: collectedText,
        stderrTail: tail.toString(),
      });
    });

    // ─── Drive the protocol ──────────────────────────────────────────
    (async () => {
      try {
        await rpc('initialize', {
          clientInfo: { name: 'orkas', title: 'Orkas', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        notify('initialized');

        threadId = await startOrResumeThread(opts);
        if (!threadId) {
          finish('failed', { error: 'codex thread/start returned no thread id', stderrTail: tail.toString() });
          return;
        }

        await rpc('turn/start', {
          threadId,
          input: [{ type: 'text', text: opts.prompt }],
          ...buildCodexTurnPermissionOverrides(opts.cwd),
        });
        // After turn/start succeeds we wait passively — turn end is
        // driven by `turn/completed` / `task_complete` notifications,
        // which call finishTurn → child.stdin.end → process exits →
        // close handler resolves outerPromise.
      } catch (err) {
        const msg = (err as Error).message || String(err);
        log.warn('codex protocol error', { error: msg });
        if (!exited) finish('failed', { error: msg, stderrTail: tail.toString() });
      }
    })();

    async function startOrResumeThread(o: BackendRunOptions): Promise<string | undefined> {
      const developerInstructions = codexDeveloperInstructions(o);
      if (o.resumeSessionId) {
        try {
          const r = await rpc('thread/resume', {
            threadId: o.resumeSessionId,
            cwd: o.cwd,
            model: o.model || null,
            ...buildCodexThreadPermissionOverrides(),
            developerInstructions,
          });
          const tid = extractThreadId(r);
          if (tid) return tid;
          log.warn('codex thread/resume returned no thread id; falling back to thread/start');
        } catch (err) {
          log.warn('codex thread/resume failed; falling back to thread/start', { error: (err as Error).message });
        }
      }
      const r = await rpc('thread/start', {
        model: o.model || null,
        modelProvider: null,
        profile: null,
        cwd: o.cwd,
        ...buildCodexThreadPermissionOverrides(),
        config: null,
        baseInstructions: null,
        developerInstructions,
        compactPrompt: null,
        includeApplyPatchTool: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
      return extractThreadId(r);
    }

    return outerPromise;
  },
};

/**
 * orkas-bridge context for codex (plan §D3): the prompt that tells the
 * agent it runs inside Orkas and which `orkas` MCP tools exist. Passed as
 * codex's `developerInstructions` — the protocol-level slot for this —
 * preferred over writing an AGENTS.md into cwd (no file pollution, no
 * cleanup-on-crash, never clobbers the user's own AGENTS.md). The bridge
 * config injection (`-c mcp_servers.orkas.*`) already connects the server;
 * this makes the agent reach for it. Returns null when no bridge is live.
 * Exported for tests.
 */
export function codexDeveloperInstructions(opts: BackendRunOptions): string | null {
  return opts.bridge?.appendSystemPrompt || null;
}

function buildCodexArgs(opts: BackendRunOptions): string[] {
  // Per multica: `codex app-server --listen stdio://` is the entry
  // point for the JSON-RPC protocol. customArgs trail.
  const args = ['app-server', '--listen', 'stdio://'];
  // orkas-bridge: codex takes config-layer overrides (`-c key=value`,
  // TOML-parsed) instead of a config file. Codex spawns stdio MCP servers
  // with a sanitized env (PATH/HOME only) — it does NOT inherit this Codex
  // process's env — so the non-secret bridge env must be injected via `-c
  // mcp_servers.orkas.env.*`. The token/socket are NOT here; they live in
  // the 0600 file that ORKAS_BRIDGE_ENV_FILE points at, so they never hit argv.
  if (opts.bridge) args.push(...buildCodexBridgeOverrides(opts.bridge.server));
  if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
  return args;
}

/** Secret-bearing bridge env keys that must never be serialized into argv.
 *  They reach orkas-bridge.cjs through the 0600 file referenced by
 *  ORKAS_BRIDGE_ENV_FILE, which IS injected (it is just a path). */
const CODEX_BRIDGE_SECRET_ENV_KEYS = new Set(['ORKAS_BRIDGE_TOKEN', 'ORKAS_BRIDGE_SOCKET']);

/** `-c mcp_servers.orkas.*` override args from the bridge server entry.
 *  Values are TOML: strings quoted, args as an inline array. The non-secret
 *  env is injected as `mcp_servers.orkas.env.<KEY>` because Codex spawns MCP
 *  servers with a sanitized env and does NOT inherit this process's env —
 *  without it orkas-bridge.cjs exits "env required" and the agent gets no
 *  orkas_* tools (skills/connectors/KB). Token/socket are filtered out so
 *  they never land in argv/events.
 *  Exported for tests. */
export function buildCodexBridgeOverrides(server: { command: string; args: string[]; env?: Record<string, string> }): string[] {
  const tomlStr = (s: string) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const argsToml = `[${server.args.map(tomlStr).join(', ')}]`;
  const overrides = [
    '-c', `mcp_servers.orkas.command=${tomlStr(server.command)}`,
    '-c', `mcp_servers.orkas.args=${argsToml}`,
  ];
  for (const [key, value] of Object.entries(server.env || {})) {
    if (value == null || CODEX_BRIDGE_SECRET_ENV_KEYS.has(key)) continue;
    overrides.push('-c', `mcp_servers.orkas.env.${key}=${tomlStr(value)}`);
  }
  return overrides;
}

export function buildCodexThreadPermissionOverrides(): { approvalPolicy: string; sandbox: string } {
  return {
    approvalPolicy: TRUSTED_LOCAL_APPROVAL_POLICY,
    sandbox: TRUSTED_LOCAL_SANDBOX_MODE,
  };
}

export function buildCodexTurnPermissionOverrides(cwd: string): {
  cwd: string;
  approvalPolicy: string;
  sandboxPolicy: { type: string };
} {
  return {
    cwd,
    approvalPolicy: TRUSTED_LOCAL_APPROVAL_POLICY,
    sandboxPolicy: { ...TRUSTED_LOCAL_SANDBOX_POLICY },
  };
}

export function extractCodexDiffFiles(diff: string): string[] {
  if (typeof diff !== 'string' || !diff) return [];
  const out = new Set<string>();
  let current = '';
  let deleted = false;
  const flush = () => {
    if (current && !deleted) out.add(current);
    current = '';
    deleted = false;
  };
  for (const raw of diff.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      flush();
      current = normalizeDiffPath(git[2] || git[1]);
      continue;
    }
    if (/^deleted file mode\b/.test(line) || line === '+++ /dev/null') {
      deleted = true;
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus) {
      const p = normalizeDiffPath(plus[1]);
      if (p) current = p;
    }
  }
  flush();
  return Array.from(out);
}

function normalizeDiffPath(raw: string): string {
  let p = String(raw || '').trim();
  if (!p || p === '/dev/null') return '';
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  return p;
}

/** Pull the `threadId` out of a `thread/start` or `thread/resume`
 *  response. Codex puts it at the top level of the result; older
 *  stubs sometimes wrap it under `thread`. Exposed for unit tests. */
export function extractThreadId(result: any): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  if (typeof result.threadId === 'string' && result.threadId) return result.threadId;
  if (result.thread && typeof result.thread.id === 'string' && result.thread.id) return result.thread.id;
  return undefined;
}

/** Extract token usage from a `thread/tokenUsage/updated` notification's
 *  params block. Codex flips between snake_case and camelCase across
 *  versions and wraps the counters under `usage` / `info.totalTokenUsage`
 *  / `info.lastTokenUsage`; we accept all observed shapes and produce
 *  the normalized `{input, output, cacheRead, cacheCreate, model}`
 *  payload the rest of the system speaks. Returns undefined when no
 *  recognizable numeric field is present.
 *
 *  Exposed for unit testing. */
export function extractCodexUsage(params: any): undefined | Record<string, number | string> {
  if (!params || typeof params !== 'object') return undefined;
  const candidates: any[] = [];
  if (params.usage) candidates.push(params.usage);
  if (params.info?.totalTokenUsage) candidates.push(params.info.totalTokenUsage);
  if (params.info?.lastTokenUsage) candidates.push(params.info.lastTokenUsage);
  if (params.payload?.info?.totalTokenUsage) candidates.push(params.payload.info.totalTokenUsage);
  if (params.payload?.info?.lastTokenUsage) candidates.push(params.payload.info.lastTokenUsage);
  // Bare params block can itself carry the fields when codex inlines them.
  candidates.push(params);

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const input = pickNum(c, ['input_tokens', 'inputTokens']);
    const output = pickNum(c, ['output_tokens', 'outputTokens']);
    const cacheRead = pickNum(c, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cachedInputTokens']);
    const cacheCreate = pickNum(c, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);
    if (input === undefined && output === undefined && cacheRead === undefined && cacheCreate === undefined) continue;
    const out: Record<string, number | string> = {};
    if (input !== undefined) out.input = input;
    if (output !== undefined) out.output = output;
    if (cacheRead !== undefined) out.cacheRead = cacheRead;
    if (cacheCreate !== undefined) out.cacheCreate = cacheCreate;
    const model = params.model || params.info?.model || params.payload?.info?.model || params.payload?.model;
    if (typeof model === 'string' && model) out.model = model;
    return out;
  }
  return undefined;
}

function pickNum(o: Record<string, any>, keys: string[]): number | undefined {
  for (const k of keys) {
    if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k];
  }
  return undefined;
}
