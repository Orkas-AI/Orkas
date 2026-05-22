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
  levelOrInfo,
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
      // Captured upstream-provider error text from stderr. ACP servers
      // (notably hermes 0.9) treat upstream HTTP 400/auth errors as
      // "non-retryable" and still return `stopReason: end_turn` with
      // an empty body — looking only at the JSON-RPC envelope makes a
      // failed turn look successful. We sniff stderr for these and
      // promote them to the run-level error if no text streamed.
      let stderrErrorHint: string | undefined;

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

      // Pre-build session/new params: include model up front (Hermes
      // accepts it; CLIs that don't honor model in session/new ignore
      // it). The set_model fallback below covers servers that need
      // an explicit setter.
      const sessionNewParams: Record<string, unknown> = {
        cwd: opts.cwd,
        mcpServers: [],
      };
      if (opts.model) sessionNewParams.model = opts.model;

      const splitter = new LineSplitter();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        splitter.push(chunk, line => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let env: any;
          try { env = JSON.parse(trimmed); }
          catch {
            // ACP wire is NDJSON; a non-JSON line means the CLI logged
            // something straight to stdout (hermes occasionally does
            // this on startup). Surface as raw-line so it appears in
            // the process rail.
            opts.onEvent({ type: 'raw-line', line: trimmed });
            return;
          }
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
            onThinking: text => opts.onEvent({ type: 'thinking', text }),
            onToolUse: tool => opts.onEvent({ type: 'tool-event', tool: tool.name, callId: tool.callId, phase: 'use', input: tool.input }),
            onToolResult: tool => opts.onEvent({ type: 'tool-event', tool: tool.name, callId: tool.callId, phase: 'result', output: tool.output }),
            onPromptResult: r => {
              resultStatus = r.ok ? 'completed' : 'failed';
              if (r.ok && r.text) resultText = r.text;
              if (!r.ok) resultError = r.error;
              // ACP servers (hermes / kimi / kiro) keep stdin open
              // ready for the next prompt — they're long-running.
              // We're a one-shot dispatcher; closing stdin signals
              // them to shut down so the close handler below fires
              // and the outer Promise resolves. Without this we hang
              // forever waiting on a child that's perfectly happy to
              // sit idle.
              try { child.stdin.end(); } catch { /* */ }
            },
            onUnknown: raw => {
              // Previously surfaced as a fake `tool:'acp'` tool-event,
              // which polluted the tools rail with category-error rows.
              // Reroute to a log event so the rail's tool list stays
              // honest and unknown ACP traffic still gets visibility.
              const summary = JSON.stringify(raw).slice(0, 200);
              opts.onEvent({
                type: 'log',
                level: 'info',
                message: `acp: ${summary}`,
                source: 'acp',
              });
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
        params: sessionNewParams,
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
          // Sniff for upstream-provider failures hermes prints just
          // before silently returning end_turn. The most useful line
          // is the "Error: HTTP 400: ..." one with the API's message;
          // we keep the FIRST hit so retries don't overwrite the root
          // cause. Pattern is intentionally loose because hermes log
          // formatting drifts version-to-version.
          if (!stderrErrorHint) {
            const m = /(HTTP\s+\d{3}[^\n]*|Non-retryable[^\n]*|Error code:\s+\d{3}[^\n]*)/.exec(line);
            if (m) stderrErrorHint = m[1].trim();
          }
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
          if (code === 0 && resultStatus === 'completed') {
            // Demote silent failure: server claimed success via
            // stopReason=end_turn but never streamed any text AND
            // stderr contained an upstream-provider error. Hermes
            // does this on auth/model misconfig (HTTP 400). Surface
            // the captured error so the chat shows a real reason
            // instead of an empty bubble.
            if (!resultText && stderrErrorHint) {
              return finish('failed', {
                error: `${def.logName.replace('local-agents:', '')} reported success but produced no text — upstream: ${stderrErrorHint}`,
                output: '',
                stderrTail: tail.toString(),
              });
            }
            return finish('completed', { output: resultText });
          }
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
  onThinking(text: string): void;
  onToolUse(tool: { name: string; callId: string; input: unknown }): void;
  onToolResult(tool: { name: string; callId: string; output: string }): void;
  onPromptResult(r: { ok: boolean; text?: string; error?: string }): void;
  onUnknown(raw: any): void;
}

/**
 * Pure dispatcher — given a parsed ACP message envelope, invokes the
 * matching handler. Exposed for unit testing without spawning the CLI.
 *
 * Field-name reality check (vs ACP spec drafts):
 *   - Hermes 0.9 uses `update.sessionUpdate` as the discriminator
 *     (string like `agent_message_chunk` / `agent_thought_chunk` /
 *     `tool_call` / `tool_call_update` / `available_commands_update`),
 *     and puts text under `update.content.text`.
 *   - Some older / draft variants use `update.kind` instead.
 *   We check `sessionUpdate` first, then `kind` so both work.
 */
export function handleAcpMessage(env: any, h: AcpHandlers): void {
  if (!env || typeof env !== 'object') return;
  // Notifications: { method: "session/update", params: { sessionId, update: {...} } }
  if (env.method === 'session/update') {
    const upd = env.params?.update;
    if (!upd || typeof upd !== 'object') return;
    const kind: string = (typeof upd.sessionUpdate === 'string' && upd.sessionUpdate)
      || (typeof upd.kind === 'string' && upd.kind)
      || '';
    if (!kind) return;
    if (kind === 'agent_message_chunk') {
      const text = upd.content?.text;
      if (typeof text === 'string' && text.length) h.onTextDelta(text);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      // Thinking/internal monologue — hermes uses these for its
      // "(◔_◔) mulling..." status messages and any planning the
      // model emits before the actual reply.
      const text = upd.content?.text;
      if (typeof text === 'string' && text.length) h.onThinking(text);
      return;
    }
    if (kind === 'tool_call' && upd.tool) {
      h.onToolUse({
        name: String(upd.tool.name || 'tool'),
        callId: String(upd.tool.id || upd.tool.callId || ''),
        input: upd.tool.input ?? {},
      });
      return;
    }
    if (kind === 'tool_call_update' && upd.tool) {
      h.onToolResult({
        name: String(upd.tool.name || 'tool'),
        callId: String(upd.tool.id || upd.tool.callId || ''),
        output: typeof upd.tool.output === 'string' ? upd.tool.output : JSON.stringify(upd.tool.output ?? ''),
      });
      return;
    }
    if (kind === 'available_commands_update') {
      // Hermes broadcasts its slash-command list right after session
      // creation. Surface as unknown so it lands in the debug rail
      // but doesn't pretend to be a tool/result event.
      h.onUnknown({ method: env.method, params: env.params });
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
