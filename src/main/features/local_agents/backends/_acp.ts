/**
 * Tiny ACP (Agent Communication Protocol) client used by ACP-speaking
 * CLIs (Hermes and OpenCode today; Kimi / Kiro can plug in here too).
 *
 * ACP wire format: newline-delimited JSON-RPC 2.0 over stdio. We send
 * `initialize`, `session/new`, `session/prompt`, answer native
 * `session/request_permission` calls, and listen for `session/update`
 * notifications (text deltas + tool events) plus the
 * id-matched `session/prompt` response (terminal). The protocol allows
 * arbitrary other notifications which we surface as raw `tool-event`
 * stream entries when their shape isn't recognized.
 *
 * Why we built our own minimal client rather than wrapping an SDK:
 * ACP is a moving target across vendors and an SDK would tie us to
 * one implementer's version pace. The handshake we need is small.
 */

import { createLogger } from '../../../logger.js';
import { logErrorSummary } from '../../../util/log-redact.js';
import { t } from '../../../i18n.js';
import { AcpDiagnostics } from './acp-diagnostics.js';
import { createPendingCliText } from '../text-phase.js';
import {
  type LocalBackend,
  type BackendRunOptions,
  StderrTail,
  spawnCli,
  armKillWatchdog,
  reapCliAfterProtocolTerminal,
  rpcErrorMessage,
  LineSplitter,
} from './base.js';

export interface AcpBackendDef {
  /** Logger name. */
  logName: string;
  /** Subcommand args for the CLI's ACP mode. e.g. `['acp']`. */
  argv: string[] | ((opts: BackendRunOptions) => string[]);
  /** Identifier we report via `clientInfo.name`. Cosmetic. */
  clientName: string;
  /** Display name of the running CLI, rather than the ACP client identity. */
  cliName?: string;
  /** Legacy fixed resume, or a strict ACP v1 handshake with negotiated resume. */
  resume?: boolean | 'negotiated';
  /** Fresh Hermes model selection rebuilds its Agent and loses session MCP tools.
   * Rebind them through advertised session/load before the first prompt. */
  refreshMcpAfterModelSelection?: boolean;
  /** Extra env vars to merge with `process.env` when spawning. */
  extraEnv?: Record<string, string> | ((opts: BackendRunOptions) => Record<string, string>);
}

export function makeAcpBackend(def: AcpBackendDef): LocalBackend {
  const log = createLogger(def.logName);
  return {
    async run(opts: BackendRunOptions): Promise<void> {
      const argv = typeof def.argv === 'function' ? def.argv(opts) : def.argv;
      const negotiate = def.resume === 'negotiated';
      const pendingText = negotiate ? createPendingCliText(opts.onEvent) : undefined;
      const extraEnv = typeof def.extraEnv === 'function' ? def.extraEnv(opts) : def.extraEnv;
      const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
      const child = spawnCli(opts.binPath, argv, opts.cwd, env);
      const tail = new StderrTail();
      const startedAt = Date.now();
      const diagnostics = new AcpDiagnostics();
      let processState: 'open' | 'exit' | 'close' = 'open';
      child.once('exit', () => { processState = 'exit'; });

      let exited = false;
      let finishProtocol!: () => void;
      let sessionId: string | undefined;
      let resultText = '';
      let resultStatus: 'completed' | 'failed' | 'cancelled' | undefined;
      let resultError: string | undefined;
      let nativeError: string | undefined;
      let compatibilityFailure: 'parameter_unsupported' | 'tool_restore_failed' | undefined;
      const toolNames = new Map<string, string>();
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
        args: argv,
      });

      const watchdog = armKillWatchdog(child, {
        timeoutMs: opts.timeoutMs,
        deadlineAt: opts.deadlineAt,
        idleKillMs: opts.idleKillMs,
        lastEventAt: opts.lastEventAt,
        terminate: () => cancelAndReap(),
      });

      const send = (msg: object) => {
        if (exited) return;
        const method = (msg as { method?: string }).method;
        if (method) diagnostics.sent(method);
        try { child.stdin.write(JSON.stringify(msg) + '\n'); }
        catch (err) { log.warn('acp stdin write failed', { error: logErrorSummary(err) }); }
      };

      // Hermes foreground commands create their own POSIX process groups.
      // The native ACP interrupt stops those tools; killing only the ACP
      // process group first would orphan them. Bound native cleanup before
      // retaining the existing TERM/KILL fallback for an unresponsive CLI.
      let cancellationRequested = false;
      const cancelAndReap = () => {
        if (cancellationRequested) return;
        cancellationRequested = true;
        if (!exited && sessionId && promptSent) {
          send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
          const cleanup = setTimeout(() => reapCliAfterProtocolTerminal(child), 500);
          child.once('close', () => clearTimeout(cleanup));
          cleanup.unref?.();
        } else {
          reapCliAfterProtocolTerminal(child);
        }
      };
      const detachAbort = () => opts.signal.removeEventListener('abort', cancelAndReap);

      // Step 1: initialize
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: def.clientName, version: '0.1.0' },
          clientCapabilities: {},
        },
      });

      // session/new carries only protocol-defined environment fields.
      const mcpServers = opts.bridge ? [{
        name: 'orkas', command: opts.bridge.server.command, args: opts.bridge.server.args,
        env: Object.entries(opts.bridge.server.env).map(([name, value]) => ({ name, value })),
      }] : [];
      const sessionNewParams: Record<string, unknown> = {
        cwd: opts.cwd,
        mcpServers,
      };
      const requestedResumeId = def.resume ? String(opts.resumeSessionId || '') : '';
      let resumeMethod: 'session/resume' | 'session/load' = 'session/resume';

      let sessionStartSent = false;
      const sendSessionStart = () => {
        if (sessionStartSent) return;
        sessionStartSent = true;
        send({
          jsonrpc: '2.0',
          id: 2,
          method: requestedResumeId ? resumeMethod : 'session/new',
          params: requestedResumeId
            ? { sessionId: requestedResumeId, cwd: opts.cwd, mcpServers }
            : sessionNewParams,
        });
      };

      const splitter = new LineSplitter();
      let modelSetTimer: NodeJS.Timeout | undefined;
      let promptSent = false;
      if (opts.signal.aborted) cancelAndReap();
      else opts.signal.addEventListener('abort', cancelAndReap, { once: true });
      const sendPrompt = (id: string) => {
        if (promptSent || cancellationRequested || opts.signal.aborted || watchdog.fired()) return;
        promptSent = true;
        if (modelSetTimer) clearTimeout(modelSetTimer);
        send({
          jsonrpc: '2.0', id: PROMPT_REQ_ID, method: 'session/prompt',
          params: {
            sessionId: id,
            prompt: [{ type: 'text', text: opts.prompt }],
          },
        });
      };
      let sessionConfiguration: any;
      let supportsSessionLoad = false;
      let needsMcpRefresh = false;
      let mcpRefreshPending = false;
      let pendingSelection: { configId?: string; value: string } | undefined;
      const selections = [
        ...(opts.modelOverride ? [{ category: 'model', value: opts.modelOverride }] : []),
        ...(opts.thinkingLevel ? [{ category: 'thought_level', value: opts.thinkingLevel }] : []),
      ];
      const failCompatibility = (code: typeof compatibilityFailure, message: string, detail?: string) => {
        resultStatus = 'failed';
        resultError = message;
        nativeError = detail;
        compatibilityFailure = code;
        finishProtocol();
      };
      const cli = def.cliName ?? def.clientName;
      const failSelection = (parameter: string, detail?: string) => failCompatibility('parameter_unsupported',
        t('cli_agent.parameter_unsupported', { cli, parameter }), detail);
      const failToolRestore = (reason: 'unsupported' | 'rejected' | 'timeout', detail?: string) => failCompatibility(
        'tool_restore_failed', t(`cli_agent.tool_restore_${reason}`, { cli }), detail);
      const applyNextSelection = (id: string) => {
        if (cancellationRequested || opts.signal.aborted || watchdog.fired()) return;
        const selection = selections.shift();
        if (!selection) {
          if (needsMcpRefresh && opts.bridge && def.refreshMcpAfterModelSelection && !requestedResumeId) {
            if (!supportsSessionLoad) { failToolRestore('unsupported'); return; }
            needsMcpRefresh = false;
            mcpRefreshPending = true;
            send({ jsonrpc: '2.0', id: 4, method: 'session/load', params: { sessionId: id, cwd: opts.cwd, mcpServers } });
            const remaining = opts.deadlineAt === undefined ? opts.timeoutMs : opts.deadlineAt - Date.now();
            modelSetTimer = setTimeout(() => failToolRestore('timeout'), Math.max(1, Math.min(15_000, remaining)));
            modelSetTimer.unref?.();
          } else sendPrompt(id);
          return;
        }
        const configs = sessionConfiguration?.configOptions;
        if (Array.isArray(configs)) {
          const config = configs.find((option: any) => option?.category === selection.category
            || (selection.category === 'model' && option?.id === 'model'));
          const values = Array.isArray(config?.options)
            ? config.options.flatMap((option: any) => Array.isArray(option?.options) ? option.options : [option]) : [];
          if (selection.category === 'thought_level' && (!config
            || !values.some((option: any) => option?.value === selection.value))) {
            applyNextSelection(id); return;
          }
          if (!config || typeof config.id !== 'string' || !config.id
            || config.type !== 'select' || !values.some((option: any) => option?.value === selection.value)) {
            failSelection(selection.category); return;
          }
          if (config.currentValue === selection.value) { applyNextSelection(id); return; }
          pendingSelection = { configId: config.id, value: selection.value };
          if (selection.category === 'model') needsMcpRefresh = true;
          send({ jsonrpc: '2.0', id: 3, method: 'session/set_config_option',
            params: { sessionId: id, configId: config.id, value: selection.value } });
        } else if (selection.category === 'model') {
          // Legacy Hermes 0.9 exposes its setter without configOptions. A
          // rejection or absent acknowledgment must never run the default model.
          if (sessionConfiguration?.models?.currentModelId === selection.value) { applyNextSelection(id); return; }
          pendingSelection = { value: selection.value };
          needsMcpRefresh = true;
          send({ jsonrpc: '2.0', id: 3, method: 'session/set_model',
            params: { sessionId: id, modelId: selection.value } });
        } else { applyNextSelection(id); return; }
        modelSetTimer = setTimeout(() => failSelection(selection.category), 3_000);
        modelSetTimer.unref?.();
      };
      const onSessionReady = (id: string) => {
        if (negotiate && sessionId) return;
        sessionId = id;
        if (bootstrapTimer) clearTimeout(bootstrapTimer);
        opts.onEvent({ type: 'status', status: 'session_ready', sessionId });
        applyNextSelection(id);
      };
      const stdoutLine = (line: string): void => {
        if (exited) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let env: any;
        try { env = JSON.parse(trimmed); }
        catch {
          diagnostics.malformed();
          // ACP wire is NDJSON; a non-JSON line means the CLI logged
          // something straight to stdout (hermes occasionally does
          // this on startup). Surface as raw-line so it appears in
          // the process rail.
          if (!negotiate) opts.onEvent({ type: 'raw-line', line: trimmed });
          return;
        }
        diagnostics.received(env);
        if (negotiate && (!env || typeof env !== 'object' || Array.isArray(env))) return;
        if (env?.method === 'session/request_permission' && env.id !== undefined) {
          const params = env.params && typeof env.params === 'object' ? env.params : {};
          const toolCall = params.toolCall && typeof params.toolCall === 'object'
            ? params.toolCall
            : {};
          const rawInput = toolCall.rawInput && typeof toolCall.rawInput === 'object'
            ? toolCall.rawInput
            : {};
          const options = Array.isArray(params.options) ? params.options : [];
          const scopedOption = (kind: 'allow_once' | 'reject_once') => options.find((option: any) =>
            option?.kind === kind && typeof option.optionId === 'string' && option.optionId.trim())?.optionId as string | undefined;
          const optionId = () => {
            if (negotiate) return scopedOption('allow_once') || '';
            const once = options.find((option: any) => {
              const id = String(option?.optionId || option?.option_id || '');
              const kind = String(option?.kind || '');
              return id === 'allow_once' || id === 'allow-once' || id === 'once' || kind === 'allow_once' || kind === 'once';
            });
            if (once) return String(once.optionId || once.option_id || 'allow_once');
            // Version-skewed agents may expose a differently named allow
            // choice. Prefer a non-persistent option and never select an
            // explicit always/session grant on the user's behalf.
            const bounded = options.find((option: any) => {
              const id = String(option?.optionId || option?.option_id || '').toLowerCase();
              const kind = String(option?.kind || '').toLowerCase();
              return !id.includes('deny') && !id.includes('reject') && !id.includes('always') && !id.includes('session')
                && !kind.includes('deny') && !kind.includes('reject') && !kind.includes('always') && !kind.includes('session');
            });
            return bounded ? String(bounded.optionId || bounded.option_id || '') : '';
          };
          const description = typeof rawInput.description === 'string' && rawInput.description.trim()
            ? rawInput.description : typeof toolCall.title === 'string' ? toolCall.title : undefined;
          const command = typeof rawInput.command === 'string' ? rawInput.command : undefined;
          diagnostics.permissionStarted();
          void (async () => {
            if (negotiate && (!promptSent || cancellationRequested || params.sessionId !== sessionId || !optionId()
              || !(description?.trim() || command?.trim()))) {
              send({ jsonrpc: '2.0', id: env.id, result: { outcome: { outcome: 'cancelled' } } });
              return;
            }
            const fullAccess = opts.permissionPolicy === 'full_access';
            const decision = fullAccess
              ? 'allow_once'
              : await (opts.requestPermission?.({
                id: String(env.id),
                tool: String(toolCall.kind || 'command'),
                description: negotiate ? description : typeof rawInput.description === 'string'
                  ? rawInput.description : typeof toolCall.title === 'string' ? toolCall.title : undefined,
                command,
              }) ?? Promise.resolve('deny'));
            if (exited) return;
            const selected = decision === 'deny' || (negotiate && cancellationRequested) ? '' : optionId();
            const option = selected || (negotiate && !cancellationRequested ? scopedOption('reject_once') : undefined);
            send({
              jsonrpc: '2.0',
              id: env.id,
              result: {
                outcome: option
                  ? { outcome: 'selected', optionId: option }
                  : { outcome: 'cancelled' },
              },
            });
            opts.onEvent({
              type: 'permission-request',
              id: String(env.id),
              tool: String(toolCall.kind || 'command'),
              ...(fullAccess
                ? { autoDecided: 'allow', reason: 'full_access' }
                : { decision: selected ? 'allow' : 'deny', reason: 'user' }),
            });
          })().catch((err) => {
            if (exited) return;
            log.warn('acp permission response failed', { error: logErrorSummary(err) });
            send({
              jsonrpc: '2.0',
              id: env.id,
              result: { outcome: { outcome: 'cancelled' } },
            });
          }).finally(() => diagnostics.permissionEnded());
          return;
        }
        if (negotiate && typeof env?.method === 'string' && env.id !== undefined) {
          send({ jsonrpc: '2.0', id: env.id, error: { code: -32601, message: 'Unsupported client request' } });
          return;
        }
        if (negotiate && Number(env?.id) === 1) {
          if (env.error) {
            resultStatus = 'failed';
            const requiresSignIn = env.error.code === -32000;
            resultError = t(requiresSignIn ? 'cli_agent.sign_in_required' : 'cli_agent.session_start_failed', { cli });
            if (!requiresSignIn) nativeError = rpcErrorMessage(env.error);
            finishProtocol();
            return;
          }
          if (env.result?.protocolVersion !== 1) {
            failSelection('ACP v1');
            return;
          }
          const capabilities = env.result.agentCapabilities;
          if (requestedResumeId && capabilities?.sessionCapabilities?.resume == null) {
            if (capabilities?.loadSession !== true) { failSelection('session resume'); return; }
            resumeMethod = 'session/load';
          }
        }
        if (Number(env.id) === 1 && !env.error) {
          supportsSessionLoad = env.result?.agentCapabilities?.loadSession === true;
          sendSessionStart();
        }
        if (Number(env.id) === 4 && sessionId && mcpRefreshPending) {
          mcpRefreshPending = false;
          if (modelSetTimer) clearTimeout(modelSetTimer);
          if (env.error || !env.result || typeof env.result !== 'object' || Array.isArray(env.result)) {
            failToolRestore('rejected', rpcErrorMessage(env.error)); return;
          }
          sendPrompt(sessionId); return;
        }
        if (Number(env.id) === 3 && sessionId && pendingSelection) {
          if (modelSetTimer) clearTimeout(modelSetTimer);
          const selection = pendingSelection; pendingSelection = undefined;
          const accepted = !env.error && (!selection.configId ||
            (Array.isArray(env.result?.configOptions) && env.result.configOptions.some((option: any) => option?.id === selection.configId
              && option.currentValue === selection.value)));
          if (!accepted) { failSelection(selection.configId || 'model', rpcErrorMessage(env.error)); return; }
          if (selection.configId) sessionConfiguration = env.result;
          applyNextSelection(sessionId);
          return;
        }
        if (Number(env.id) === 2 && !env.error) sessionConfiguration = env.result;
        if (Number(env.id) === 2 && env.error) {
          resultStatus = 'failed';
          const requiresSignIn = negotiate && env.error.code === -32000;
          resultError = negotiate
            ? t(requiresSignIn ? 'cli_agent.sign_in_required' : 'cli_agent.session_start_failed', { cli })
            : typeof env.error.message === 'string'
            ? env.error.message
            : 'ACP session could not be started';
          if (negotiate && !requiresSignIn) nativeError = rpcErrorMessage(env.error);
          finishProtocol();
          return;
        }
        if (Number(env.id) === 2 && requestedResumeId && !env.error) {
          if (negotiate && (!env.result || typeof env.result !== 'object' || Array.isArray(env.result)
            || (typeof env.result.sessionId === 'string' && env.result.sessionId !== requestedResumeId))) {
            failSelection('session resume');
            return;
          }
          onSessionReady(requestedResumeId);
          return;
        }
        if (negotiate && env.method === 'session/update') {
          if (!promptSent || env.params?.sessionId !== sessionId) return;
          const update = env.params.update;
          if (update?.sessionUpdate === 'tool_call_update'
            && (update.status === 'pending' || update.status === 'in_progress')) {
            opts.onActivity?.();
            return;
          }
        }
        if (negotiate && Number(env.id) === PROMPT_REQ_ID) {
          if (!promptSent) return;
          if (env.error || typeof env.result?.stopReason !== 'string') {
            resultStatus = 'failed';
            const requiresSignIn = env.error?.code === -32000;
            resultError = t(requiresSignIn ? 'cli_agent.sign_in_required' : 'cli_agent.turn_failed', { cli });
            if (!requiresSignIn) nativeError = rpcErrorMessage(env.error);
            finishProtocol();
            return;
          }
          if (env.result.stopReason === 'cancelled') {
            resultStatus = 'cancelled';
            finishProtocol();
            return;
          }
        }
        handleAcpMessage(env, {
          onSessionNew: onSessionReady,
          onTextDelta: text => {
            if (pendingText) { pendingText.append(text); return; }
            resultText += text;
            opts.onEvent({ type: 'text-delta', text });
          },
          onThinking: text => opts.onEvent({ type: 'thinking', text }),
          onToolUse: tool => {
            if (tool.callId && !toolNames.has(tool.callId)) pendingText?.finalizeCommentary();
            if (tool.callId) toolNames.set(tool.callId, tool.name);
            opts.onEvent({ type: 'tool-event', tool: tool.name, callId: tool.callId, phase: 'use', input: tool.input });
          },
          onToolResult: tool => {
            const name = tool.name === 'tool' && tool.callId
              ? toolNames.get(tool.callId) || tool.name
              : tool.name;
            opts.onEvent({ type: 'tool-event', tool: name, callId: tool.callId, phase: 'result', output: tool.output });
            if (tool.callId) toolNames.delete(tool.callId);
          },
          onMediaOutput: media => opts.onEvent({
            type: 'media-output',
            source: 'acp',
            callId: media.callId,
            items: media.items,
          }),
          onPromptResult: r => {
            resultStatus = r.ok ? 'completed' : 'failed';
            if (r.ok && r.text) resultText = r.text;
            if (!r.ok) resultError = r.error;
            finishProtocol();
          },
          onUnknown: raw => {
            if (negotiate) return;
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
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (exited) return;
        diagnostics.bytes('stdout');
        splitter.push(chunk, stdoutLine);
      });
      child.stdout.on('end', () => splitter.flush(stdoutLine));

      // Fire-and-forget timeout to be sure session start goes; some CLIs
      // ack initialize without printing anything we'd recognize as the
      // ack, and then sit idle. The one-shot guard prevents a late fallback
      // from creating a second session after a normal initialize response.
      const initTimer = negotiate ? undefined : setTimeout(sendSessionStart, 250);
      initTimer?.unref?.();
      const bootstrapTimer = negotiate ? setTimeout(() => {
        resultStatus = 'failed';
        resultError = t('cli_agent.session_start_failed', { cli });
        finishProtocol();
      }, 15_000) : undefined;
      bootstrapTimer?.unref?.();

      const stderrLines = new LineSplitter(64 * 1024);
      const stderrLine = (line: string) => {
        if (line && !negotiate) opts.onEvent({ type: 'stderr-line', line });
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        if (exited) return;
        diagnostics.bytes('stderr');
        if (negotiate) return;
        tail.push(chunk);
        stderrLines.push(chunk, stderrLine);
        // Preserve the existing error-hint interpretation on received chunks.
        for (const line of chunk.split(/\r?\n/)) {
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
        let endReason: 'protocol' | 'close' | 'spawn_error' = 'close';
        const finish = (status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Record<string, unknown> = {}) => {
          if (exited) return;
          exited = true;
          stderrLines.flush(stderrLine);
          watchdog.disarm();
          if (initTimer) clearTimeout(initTimer);
          if (bootstrapTimer) clearTimeout(bootstrapTimer);
          if (modelSetTimer) clearTimeout(modelSetTimer);
          detachAbort();
          if (status !== 'completed') pendingText?.finalizeCommentary();
          // Keep one bounded local diagnostic summary per dispatch.
          // It must not count as fresh CLI progress.
          const summary = diagnostics.snapshot(status, endReason, processState, child.exitCode);
          log.info('ACP run diagnostics', summary);
          opts.onEvent({
            type: 'log', level: 'info', source: 'acp-diagnostics', synthetic: true,
            message: `ACP ${JSON.stringify(summary)}`,
          });
          opts.onEvent({
            type: 'done',
            status,
            durationMs: Date.now() - startedAt,
            sessionId,
            ...extra,
            ...(pendingText ? { output: pendingText.output() } : {}),
          });
          resolve();
        };
        finishProtocol = () => {
          if (exited) return;
          stderrLines.flush(stderrLine);
          endReason = 'protocol';
          try {
            if (opts.signal.aborted) return finish('cancelled', { output: resultText });
            if (watchdog.fired() && !compatibilityFailure) return finish('timeout', {
              timeoutKind: watchdog.fired(), error: `cli ${watchdog.reason()}`,
              output: resultText, stderrTail: tail.toString(),
            });
            if (resultStatus === 'failed') return finish('failed', {
              error: resultError, output: resultText, stderrTail: tail.toString(),
              ...(nativeError ? { nativeError } : {}),
              ...(compatibilityFailure ? { cliError: compatibilityFailure, failureKind: 'cli_compatibility', retrySafe: false } : {}),
            });
            if (resultStatus === 'cancelled') return finish('cancelled', { output: resultText });
            // Preserve the existing Hermes silent-provider-failure handling
            // for diagnostic evidence received before the protocol terminal.
            if (!resultText && stderrErrorHint) return finish('failed', {
              error: `${def.logName.replace('local-agents:', '')} reported success but produced no text — upstream: ${stderrErrorHint}`,
              output: '', stderrTail: tail.toString(),
            });
            finish('completed', { output: resultText });
          } finally {
            // The protocol response ends this one-shot dispatch. Cleanup owns
            // its own bounded lifetime; inherited pipes or a persistent server
            // must not keep the turn open or replace its outcome with timeout.
            if (!cancellationRequested) reapCliAfterProtocolTerminal(child);
          }
        };
        child.on('error', err => {
          if (exited) return;
          endReason = 'spawn_error';
          log.warn('acp spawn error', { error: logErrorSummary(err) });
          finish('failed', {
            error: (err as Error).message,
            stderrTail: tail.toString(),
            failureKind: 'cli_spawn',
            retrySafe: true,
          });
        });
        child.on('close', code => {
          if (exited) return;
          stderrLines.flush(stderrLine);
          processState = 'close';
          if (opts.signal.aborted) return finish('cancelled', { output: resultText });
          if (watchdog.fired() && mcpRefreshPending) return failToolRestore('timeout');
          if (watchdog.fired()) return finish('timeout', { timeoutKind: watchdog.fired(), error: `cli ${watchdog.reason()}`, output: resultText, stderrTail: tail.toString() });
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
  onMediaOutput(media: { callId: string; items: Array<Record<string, string>> }): void;
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
    if (kind === 'tool_call') {
      const tool = upd.tool && typeof upd.tool === 'object' ? upd.tool : {};
      const callId = String(upd.toolCallId || tool.id || tool.callId || '');
      const name = String(upd.title || tool.name || upd.kind || 'tool');
      h.onToolUse({
        name,
        callId,
        input: upd.rawInput ?? tool.input ?? {},
      });
      emitAcpMedia(upd, callId, h);
      return;
    }
    if (kind === 'tool_call_update') {
      const tool = upd.tool && typeof upd.tool === 'object' ? upd.tool : {};
      const callId = String(upd.toolCallId || tool.id || tool.callId || '');
      h.onToolResult({
        name: String(upd.title || tool.name || 'tool'),
        callId,
        output: acpToolOutput(upd, tool),
      });
      emitAcpMedia(upd, callId, h);
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

function acpToolOutput(upd: any, tool: any): string {
  const raw = upd.rawOutput ?? tool.output;
  if (typeof raw === 'string') return raw;
  if (raw !== undefined) return JSON.stringify(raw);
  if (!Array.isArray(upd.content)) return '';
  return upd.content.flatMap((item: any): string[] => {
    const content = item?.type === 'content' ? item.content : item;
    return content?.type === 'text' && typeof content.text === 'string' ? [content.text] : [];
  }).join('\n');
}

function emitAcpMedia(upd: any, callId: string, h: AcpHandlers): void {
  const items: Array<Record<string, string>> = [];
  if (Array.isArray(upd.content)) {
    for (const entry of upd.content) {
      const content = entry?.type === 'content' ? entry.content : entry;
      if (content?.type !== 'image') continue;
      const data = typeof content.data === 'string' ? content.data.trim() : '';
      const uri = typeof content.uri === 'string' ? content.uri.trim() : '';
      const mediaType = typeof content.mimeType === 'string' ? content.mimeType.trim() : '';
      if (data || uri) items.push({
        ...(data ? { data } : {}),
        ...(uri ? { uri } : {}),
        ...(mediaType ? { mediaType } : {}),
      });
    }
  }
  const raw = upd.rawOutput ?? upd.tool?.output;
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.image === 'string' && parsed.image.trim()) {
    items.push({ uri: parsed.image.trim() });
  }
  if (items.length) h.onMediaOutput({ callId, items });
}
