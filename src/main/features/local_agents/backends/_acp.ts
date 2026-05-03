/**
 * Tiny ACP (Agent Communication Protocol) client used by ACP-speaking
 * CLIs (Hermes today; Kimi / Kiro will plug in here too).
 *
 * ACP wire format: newline-delimited JSON-RPC 2.0 over stdio. We send
 * `initialize`, `session/new`, `session/prompt` and listen for
 * `session/update` notifications (text deltas + tool events) plus the
 * id-matched `session/prompt` response (terminal). The protocol allows
 * arbitrary other notifications which we surface as raw `tool-event`
 * stream entries when their shape isn't recognized.
 *
 * Why we built our own minimal client rather than wrapping an SDK:
 * ACP is a moving target across vendors and an SDK would tie us to
 * one implementer's version pace. The handshake we need is small.
 */

import { createLogger } from '../../../logger.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  StderrTail,
  spawnCli,
  bindAbort,
  LineSplitter,
} from './base.js';

export interface AcpBackendDef {
  /** Logger name. */
  logName: string;
  /** Subcommand args for the CLI's ACP mode. e.g. `['acp']`. */
  argv: string[];
  /** Identifier we report via `clientInfo.name`. Cosmetic. */
  clientName: string;
  /** Extra env vars to merge with `process.env` when spawning. */
  extraEnv?: Record<string, string>;
}

export function makeAcpBackend(def: AcpBackendDef): LocalBackend {
  const log = createLogger(def.logName);
  return {
    async run(opts: BackendRunOptions): Promise<void> {
      const env = def.extraEnv ? { ...process.env, ...def.extraEnv } : process.env;
      const child = spawnCli(opts.binPath, def.argv, opts.cwd, env);
      const detachAbort = bindAbort(child, opts.signal);
      const tail = new StderrTail();
      const startedAt = Date.now();

      let exited = false;
      let timedOut = false;
      let sessionId: string | undefined;
      let resultText = '';
      let resultStatus: 'completed' | 'failed' | undefined;
      let resultError: string | undefined;

      const PROMPT_REQ_ID = 100;

      opts.onEvent({
        type: 'process-info',
        pid: child.pid ?? -1,
        cwd: opts.cwd,
        cmd: opts.binPath,
        args: def.argv,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 10_000).unref();
      }, opts.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const send = (msg: object) => {
        try { child.stdin.write(JSON.stringify(msg) + '\n'); }
        catch (err) { log.warn('acp stdin write failed', { error: (err as Error).message }); }
      };

      // Step 1: initialize
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: def.clientName, version: '0.1.0' },
          clientCapabilities: {},
        },
      });

      const splitter = new LineSplitter();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        splitter.push(chunk, line => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let env: any;
          try { env = JSON.parse(trimmed); } catch { return; }
          handleAcpMessage(env, {
            onSessionNew: id => {
              sessionId = id;
              opts.onEvent({ type: 'status', status: 'session_ready', sessionId });
              // Optional model selection. We swallow errors here:
              // some CLIs reject unknown ids; we still try the prompt
              // so the user gets something rather than a hard fail.
              if (opts.model) {
                send({ jsonrpc: '2.0', id: 3, method: 'session/set_model', params: { sessionId: id, modelId: opts.model } });
              }
              send({
                jsonrpc: '2.0', id: PROMPT_REQ_ID, method: 'session/prompt',
                params: {
                  sessionId: id,
                  prompt: [{ type: 'text', text: opts.prompt }],
                },
              });
            },
            onTextDelta: text => {
              resultText += text;
              opts.onEvent({ type: 'text-delta', text });
            },
            onToolUse: tool => opts.onEvent({ type: 'tool-event', tool: tool.name, callId: tool.callId, phase: 'use', input: tool.input }),
            onToolResult: tool => opts.onEvent({ type: 'tool-event', tool: tool.name, callId: tool.callId, phase: 'result', output: tool.output }),
            onPromptResult: r => {
              resultStatus = r.ok ? 'completed' : 'failed';
              if (r.ok && r.text) resultText = r.text;
              if (!r.ok) resultError = r.error;
            },
            onUnknown: raw => {
              opts.onEvent({ type: 'tool-event', tool: 'acp', phase: 'use', input: raw, callId: '' });
            },
          });
        });
      });

      // Initialize response handler — sends session/new only after
      // the server acked initialize. We track this through the
      // generic message handler by id matching.
      child.on('message', () => { /* noop */ });

      // Drive the session/new request once we see the initialize
      // response (id=1). We piggy-back on the first object that sets
      // sessionId being the session/new response, but to keep flow
      // explicit we send session/new immediately after initialize
      // ack — the ACP spec allows this since session/new doesn't need
      // any post-initialize state.
      const sendSessionNew = () => send({
        jsonrpc: '2.0', id: 2, method: 'session/new',
        params: { cwd: opts.cwd, mcpServers: [] },
      });
      // Fire-and-forget timeout to be sure session/new goes; some CLIs
      // ack initialize without printing anything we'd recognize as the
      // ack, and then sit idle.
      const initTimer = setTimeout(sendSessionNew, 250);
      if (typeof initTimer.unref === 'function') initTimer.unref();

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        tail.push(chunk);
        for (const line of chunk.split(/\r?\n/)) {
          if (line) opts.onEvent({ type: 'stderr-line', line });
        }
      });

      return new Promise<void>(resolve => {
        const finish = (status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Record<string, unknown> = {}) => {
          if (exited) return;
          exited = true;
          clearTimeout(timer);
          clearTimeout(initTimer);
          detachAbort();
          opts.onEvent({
            type: 'done',
            status,
            durationMs: Date.now() - startedAt,
            sessionId,
            ...extra,
          });
          resolve();
        };
        child.on('error', err => {
          log.warn('acp spawn error', { error: (err as Error).message });
          finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
        });
        child.on('close', code => {
          if (opts.signal.aborted) return finish('cancelled', { output: resultText });
          if (timedOut) return finish('timeout', { error: `cli exceeded ${opts.timeoutMs}ms`, output: resultText, stderrTail: tail.toString() });
          if (code === 0 && resultStatus === 'completed') return finish('completed', { output: resultText });
          const err = resultError || (code !== 0 ? `cli exited with code ${code}` : 'cli closed without prompt result');
          finish('failed', { error: err, output: resultText, stderrTail: tail.toString() });
        });
      });
    },
  };
}

interface AcpHandlers {
  onSessionNew(sessionId: string): void;
  onTextDelta(text: string): void;
  onToolUse(tool: { name: string; callId: string; input: unknown }): void;
  onToolResult(tool: { name: string; callId: string; output: string }): void;
  onPromptResult(r: { ok: boolean; text?: string; error?: string }): void;
  onUnknown(raw: any): void;
}

/**
 * Pure dispatcher — given a parsed ACP message envelope, invokes the
 * matching handler. Exposed for unit testing without spawning the CLI.
 */
export function handleAcpMessage(env: any, h: AcpHandlers): void {
  if (!env || typeof env !== 'object') return;
  // Notifications: { method: "session/update", params: { sessionId, update: {...} } }
  if (env.method === 'session/update') {
    const upd = env.params?.update;
    if (!upd || typeof upd !== 'object') return;
    // Common kinds (per ACP spec): agent_message_chunk, tool_call, tool_call_update, finished.
    if (upd.kind === 'agent_message_chunk' && typeof upd.content?.text === 'string') {
      h.onTextDelta(upd.content.text);
      return;
    }
    if (upd.kind === 'tool_call' && upd.tool) {
      h.onToolUse({
        name: String(upd.tool.name || 'tool'),
        callId: String(upd.tool.id || upd.tool.callId || ''),
        input: upd.tool.input ?? {},
      });
      return;
    }
    if (upd.kind === 'tool_call_update' && upd.tool) {
      h.onToolResult({
        name: String(upd.tool.name || 'tool'),
        callId: String(upd.tool.id || upd.tool.callId || ''),
        output: typeof upd.tool.output === 'string' ? upd.tool.output : JSON.stringify(upd.tool.output ?? ''),
      });
      return;
    }
    h.onUnknown({ method: env.method, params: env.params });
    return;
  }
  // Responses: { id, result } or { id, error }.
  if (env.id !== undefined) {
    if (env.error) {
      // Surface the error only when this is the prompt response — other
      // request errors (e.g. set_model on an unknown id) are tolerable.
      if (Number(env.id) === 100) {
        h.onPromptResult({ ok: false, error: typeof env.error.message === 'string' ? env.error.message : 'acp error' });
      }
      return;
    }
    const idNum = Number(env.id);
    if (idNum === 2 && env.result?.sessionId) {
      h.onSessionNew(String(env.result.sessionId));
      return;
    }
    if (idNum === 100) {
      // Prompt completed. result.stopReason tells us why.
      const ok = !env.result?.stopReason || env.result.stopReason === 'end_turn';
      h.onPromptResult({ ok, error: ok ? undefined : String(env.result?.stopReason || 'unknown') });
      return;
    }
  }
}
