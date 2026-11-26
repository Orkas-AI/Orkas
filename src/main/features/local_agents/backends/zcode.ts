import { createHash, randomUUID } from 'node:crypto';
import { t } from '../../../i18n.js';
import { createPendingCliText } from '../text-phase.js';
import {
  armKillWatchdog, LineSplitter, reapCliAfterProtocolTerminal, rpcErrorMessage, spawnCli, type LocalBackend,
} from './base.js';

const CLI_NAME = 'ZCode';
const ARGV = ['app-server', '--stdio'];

type Terminal = { status: 'completed' | 'failed' | 'cancelled' | 'timeout'; error?: string; nativeError?: string };

/** The ZCode legacy stdio protocol settles on a session event, independently
 * of the request that accepted the prompt and of the app-server lifetime. */
export const zcodeBackend: LocalBackend = {
  async run(opts) {
    if (opts.signal.aborted) {
      opts.onEvent({ type: 'done', status: 'cancelled' });
      return;
    }
    const child = spawnCli(opts.binPath, ARGV, opts.cwd);
    const started = Date.now();
    const inputId = randomUUID();
    opts.onEvent({ type: 'process-info', pid: child.pid ?? -1, cmd: opts.binPath, args: ARGV, cwd: opts.cwd });
    const server = opts.bridge?.server;
    const mcpServers = server ? [{
      name: 'orkas', command: server.command, args: server.args,
      env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
    }] : [];
    const requestedSession = opts.resumeSessionId;
    const startParams = requestedSession ? { sessionId: requestedSession, mcpServers } : {
      workspace: {
        workspaceKey: createHash('sha256').update(opts.cwd).digest('hex'),
        workspacePath: opts.cwd,
      },
      mode: 'build', persistence: 'immediate', mcpServers,
    };
    const text = (key: string) => t(key, { cli: CLI_NAME });

    await new Promise<void>(resolve => {
      let settled = false;
      let submitted = false;
      let accepted = false;
      let sessionId: string | undefined;
      let turnId: string | undefined;
      let lastSeq = -1;
      const pendingText = createPendingCliText(opts.onEvent);
      let terminalText: string | undefined;
      let final: Terminal | undefined;
      let stopping: ReturnType<typeof setTimeout> | undefined;
      const tools = new Map<string, string>();

      const send = (value: object) => {
        if (!settled && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n');
      };
      const failed = (key = 'cli_agent.turn_failed', nativeError?: string): Terminal => ({
        status: 'failed', error: text(key), ...(nativeError ? { nativeError } : {}),
      });
      const finish = (result: Terminal) => {
        if (settled) return;
        settled = true;
        watchdog.disarm();
        clearTimeout(bootstrapTimer);
        if (stopping) clearTimeout(stopping);
        opts.signal.removeEventListener('abort', stop);
        if (result.status !== 'completed' || terminalText === '') pendingText.finalizeCommentary();
        opts.onEvent({
          type: 'done', ...result, output: result.status === 'completed' ? (terminalText ?? pendingText.output()) : '',
          sessionId, durationMs: Date.now() - started,
          ...(watchdog.fired() && !opts.signal.aborted ? { timeoutKind: watchdog.fired() } : {}),
        });
        reapCliAfterProtocolTerminal(child);
        resolve();
      };
      const stop = () => {
        if (settled || stopping) return;
        const result: Terminal = opts.signal.aborted ? { status: 'cancelled' } : { status: 'timeout' };
        if (!sessionId || !turnId) { finish(result); return; }
        send({ id: 4, method: 'session/stop', params: { sessionId } });
        stopping = setTimeout(() => finish(result), 500);
        stopping.unref?.();
      };
      const watchdog = armKillWatchdog(child, {
        timeoutMs: opts.timeoutMs, deadlineAt: opts.deadlineAt, idleKillMs: opts.idleKillMs,
        lastEventAt: opts.lastEventAt, terminate: stop,
      });
      const bootstrapTimer = setTimeout(() => {
        if (submitted) stop();
        else finish(failed('cli_agent.session_start_failed'));
      }, 15_000);
      bootstrapTimer.unref?.();
      opts.signal.addEventListener('abort', stop, { once: true });

      const readLine = (line: string) => {
        if (settled) return;
        let envelope: any;
        try { envelope = JSON.parse(line); } catch { return; }
        if (!envelope || typeof envelope !== 'object') return;
        const { id, method, params, result, error } = envelope;
        if (typeof method === 'string' && id != null) {
          if (method === 'session/requestRuntimePreferences') {
            send({ id, result: {
              nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: false,
            } });
          } else if (method === 'interaction/requestPermission') {
            const actionable = turnId && !stopping && params?.sessionId === sessionId
              && (!params.turnId || params.turnId === turnId) && typeof params.toolName === 'string'
              && !!params.toolName && typeof params.reason === 'string' && !!params.reason
              && Array.isArray(params.options) && params.options.some((option: any) =>
                option?.response?.decision === 'allow' && !option.response.permissionUpdates?.length);
            const decision = actionable ? opts.requestPermission?.({
              id: String(id), tool: params.toolName, description: params.reason,
              command: typeof params.input?.command === 'string' ? params.input.command : undefined,
            }) : undefined;
            void Promise.resolve(decision).then(answer => send({ id, result: {
              decision: !stopping && (answer === 'allow_once' || answer === 'allow_run') ? 'allow' : 'deny',
            } })).catch(() => send({ id, result: { decision: 'deny' } }));
          } else if (method === 'interaction/requestUserInput') {
            send({ id, result: { action: 'cancel' } });
          } else send({ id, error: { code: -32601, message: 'Unsupported client request' } });
          return;
        }
        if (id === 1 && !sessionId) {
          if (requestedSession && error?.code === -32004) {
            opts.onEvent({ type: 'status', status: 'resume-rejected' });
          }
          const current = result?.session?.sessionId;
          if (error || result?.protocol?.name !== 'ZCode Protocol' || result.protocol.version !== 1
            || typeof current !== 'string' || !current || (requestedSession && current !== requestedSession)
            || result.projection?.mode !== 'build') {
            finish(failed('cli_agent.session_start_failed', rpcErrorMessage(error)));
            return;
          }
          sessionId = current;
          opts.onEvent({ type: 'status', status: 'session_ready', sessionId });
          send({ id: 2, method: 'session/subscribe', params: { sessionId, deliveryKind: 'desktop-continuous' } });
          return;
        }
        if (id === 2 && !submitted) {
          if (error || result?.sessionId !== sessionId || !Number.isSafeInteger(result?.eventSeq) || result.eventSeq < 0) {
            finish(failed('cli_agent.session_start_failed', rpcErrorMessage(error)));
            return;
          }
          lastSeq = result.eventSeq;
          submitted = true;
          opts.onEvent({ type: 'status', status: 'running', sessionId });
          send({ id: 3, method: 'session/send', params: { sessionId, inputId, content: opts.prompt } });
          return;
        }
        if (id === 3 && submitted && !accepted) {
          if (error || result?.sessionId !== sessionId || result.accepted !== true) {
            finish(failed('cli_agent.turn_failed', rpcErrorMessage(error)));
            return;
          }
          accepted = true;
          clearTimeout(bootstrapTimer);
          if (final) finish(final);
          return;
        }
        if (method !== 'session/event' || !submitted || params?.sessionId !== sessionId
          || !Number.isSafeInteger(params.seq) || params.seq <= lastSeq || final) return;
        lastSeq = params.seq;
        if (params.type === 'turn.started' && !turnId && params.payload?.inputId === inputId
          && typeof params.turnId === 'string') turnId = params.turnId;
        if (!turnId || params.turnId !== turnId) return;
        const item = params.payload;
        if (params.type === 'model.streaming' && typeof item?.delta === 'string') {
          if (item.kind === 'text_delta') {
            pendingText.append(item.delta);
          } else if (item.kind === 'reasoning_delta') opts.onEvent({ type: 'thinking', text: item.delta });
        } else if (params.type === 'tool.updated' && typeof item?.toolCallId === 'string') {
          const callId = item.toolCallId;
          if ((item.kind === 'started' || item.kind === 'scheduled') && !tools.has(callId)) {
            pendingText.finalizeCommentary();
            const tool = typeof item.toolName === 'string' ? item.toolName : 'tool';
            tools.set(callId, tool);
            opts.onEvent({ type: 'tool-event', phase: 'use', tool, callId, input: item.input });
          } else if ((item.kind === 'result' || item.kind === 'error') && tools.has(callId)) {
            opts.onEvent({
              type: 'tool-event', phase: 'result', tool: tools.get(callId)!, callId,
              output: typeof item.result?.content === 'string' ? item.result.content : '',
            });
            tools.delete(callId);
          }
        } else if (params.type === 'turn.completed' || params.type === 'turn.failed') {
          if (stopping || item?.resultType === 'cancelled') final = { status: opts.signal.aborted ? 'cancelled' : watchdog.fired() ? 'timeout' : 'cancelled' };
          else if (params.type === 'turn.completed' && item?.resultType === 'success') {
            if (typeof item.response === 'string') terminalText = item.response;
            final = { status: 'completed' };
          } else final = failed('cli_agent.turn_failed', rpcErrorMessage(item?.error));
          if (accepted) finish(final);
        }
      };
      const lines = new LineSplitter();
      child.stdout.setEncoding('utf8').on('data', chunk => lines.push(chunk, readLine));
      child.stdout.on('end', () => lines.flush(readLine));
      child.stderr.resume();
      child.once('error', error => finish(failed('cli_agent.session_start_failed', error.message)));
      child.once('close', () => finish(opts.signal.aborted ? { status: 'cancelled' }
        : watchdog.fired() ? { status: 'timeout' } : failed()));
      if (opts.signal.aborted) stop();
      else send({ id: 1, method: requestedSession ? 'session/resume' : 'session/create', params: startParams });
    });
  },
};
