/**
 * Claude Code backend. Runs `claude -p --output-format stream-json
 * --input-format stream-json --verbose` and keeps stdin open for permission
 * responses, explicit active-turn steering, and self-woken background-task
 * follow-ups. Output is one JSON object per line; we recognize:
 *
 *   {"type":"system","subtype":"init", session_id, cwd, ...}
 *   {"type":"assistant","message":{ "content":[{type:"text", text}, {type:"tool_use",...}, {type:"thinking",...}] }}
 *   {"type":"user","message":{ "content":[{type:"tool_result", tool_use_id, content}] }}
 *   {"type":"result","subtype":"success"|"error_*", result, total_cost_usd, duration_ms, ...}
 *
 * Non-conforming lines (banner text, debug noise) are silently dropped
 * so a noisy CLI version doesn't bork a run.
 */

import { createLogger } from '../../../logger.js';
import { AGENT_EXECUTION_MAX_MS } from '../../../util/agent-execution-budget.js';
import { logErrorSummary } from '../../../util/log-redact.js';
import {
  type LocalBackend,
  type LocalActiveRunIngress,
  type LocalActiveRunInput,
  type BackendRunOptions,
  type LocalEvent,
  type LocalCliPermissionDecision,
  StderrTail,
  spawnCli,
  reapCliAfterProtocolTerminal,
  killProcessTree,
  armKillWatchdog,
  LineSplitter,
  levelOrInfo,
  isFileReadToolName,
} from './base.js';

const log = createLogger('local-agents:claude');

/** Compatibility export for existing background probes; production uses the
 *  shared dispatch watchdog in both foreground and background phases. */
export const CLAUDE_BACKGROUND_TIMEOUT_MS = AGENT_EXECUTION_MAX_MS;
/** Grace for the CLI to answer our `interrupt` before stdin closes. */
const GRACEFUL_STOP_MS = 2_000;

/** Test/probe override for the background hard cap, mirroring
 *  ORKAS_LOCAL_AGENT_IDLE_KILL_MS. Bounded and read per run so a harness can
 *  set it without re-importing the module. */
function backgroundTimeoutMs(): number {
  const raw = process.env.ORKAS_LOCAL_AGENT_BACKGROUND_TIMEOUT_MS;
  const fallback = CLAUDE_BACKGROUND_TIMEOUT_MS;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 100 && n <= 7 * 24 * 60 * 60_000
    ? Math.round(n)
    : fallback;
}

export const claudeBackend: LocalBackend = {
  async run(opts: BackendRunOptions): Promise<void> {
    const args = buildClaudeArgs(opts);
    const child = spawnCli(opts.binPath, args, opts.cwd);
    const tail = new StderrTail();
    const startedAt = Date.now();
    const deadlineAt = Math.min(opts.deadlineAt ?? Infinity, startedAt + opts.timeoutMs);

    let sessionId: string | undefined;
    let exited = false;
    let closingForTerminal = false;
    let phase: 'foreground' | 'background' = 'foreground';
    let doneEmitted = false;
    let resultText = '';
    const completedTurnTexts: string[] = [];
    let resultStatus: 'completed' | 'failed' | undefined;
    let resultError: string | undefined;
    let resultUsage: Record<string, number | string> | undefined;
    let activeInputOpen = false;
    let finishRun: (
      status: 'completed' | 'failed' | 'cancelled' | 'timeout',
      extra?: Partial<LocalEvent>,
    ) => void = () => {};
    /** Running token tally accumulated from each `assistant` block's
     *  `message.usage` (mirrors multica's per-model map). The final
     *  `result.usage` claude itself emits is authoritative and overwrites
     *  this when the turn ends; in the meantime accUsage drives the
     *  live `status:'usage'` row. */
    let accUsage: Record<string, number | string> | undefined;
    // Tracks whether we've seen a real stream_event with text content
    // — gates whether we can safely skip the assistant block's text
    // (which would otherwise duplicate the streamed body). Old claude
    // versions that ignore `--include-partial-messages` never emit
    // stream_events; in that case we fall back to emitting from the
    // assistant block so the user still sees the final text.
    const partialState: ClaudeParseState = {
      sawTextStreamEvent: false,
      toolNamesByCallId: new Map<string, string>(),
    };

    opts.onEvent({
      type: 'process-info',
      pid: child.pid ?? -1,
      cwd: opts.cwd,
      cmd: opts.binPath,
      args,
    });

    const watchdog = armKillWatchdog(child, {
      timeoutMs: opts.timeoutMs,
      deadlineAt,
      idleKillMs: opts.idleKillMs,
      lastEventAt: opts.lastEventAt,
    });

    // Serialize user messages and control responses through one writer. Claude
    // Code's stream-json stdin is a multiplexed protocol; concurrent writes
    // must never interleave records or let a steer overtake a pending approval
    // response.
    let stdinWrites: Promise<void> = Promise.resolve();
    const writeInputRecord = (record: Record<string, unknown>): Promise<void> => {
      const line = `${JSON.stringify(record)}\n`;
      const write = stdinWrites.then(() => new Promise<void>((resolve, reject) => {
        if (exited || child.stdin.destroyed || !child.stdin.writable) {
          reject(new Error('claude stdin is no longer writable'));
          return;
        }
        child.stdin.write(line, (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      }));
      // Keep the shared chain usable after one failed record while returning
      // the original rejection to that caller.
      stdinWrites = write.catch(() => {});
      return write;
    };

    const publishActiveIngress = (ready: boolean): void => {
      activeInputOpen = ready && !exited;
      if (!activeInputOpen) {
        try { opts.onActiveRunIngress?.(null); } catch { /* host already gone */ }
        return;
      }
      const ingress: LocalActiveRunIngress = {
        submit: async (input: LocalActiveRunInput) => {
          if (!activeInputOpen || exited) {
            return { mode: 'queued_followup', reason: 'claude turn is no longer active' };
          }
          const text = String(input.text || '').trim();
          if (!text) return { mode: 'rejected', reason: 'empty active-turn input' };
          try {
            await writeInputRecord({
              type: 'user',
              message: {
                role: 'user',
                content: [{ type: 'text', text }],
              },
            });
            return { mode: 'steered', acceptedId: input.id };
          } catch (err) {
            return {
              mode: 'queued_followup',
              reason: (err as Error).message || String(err),
            };
          }
        },
      };
      try { opts.onActiveRunIngress?.(ingress); } catch { /* host already gone */ }
    };

    // ---- background tasks inside one continuous host turn ----------------
    // Closing stdin on Claude's first `result` destroys any task it left in the
    // background. Ending the host turn there is equally wrong: it clears the
    // bus AbortController, ends loading, and lets the renderer drain the next
    // queued message while Claude is still working. Keep one run/turn instead.
    // A Set is sufficient because Claude may report one retirement twice and
    // delete is naturally idempotent.
    const liveTasks = new Set<string>();
    const liveTaskDetails = new Map<string, { taskType?: string; message?: string }>();
    const trackTask = (event: LocalEvent): void => {
      if (event.type !== 'status') return;
      const status = String(event.status || '');
      const taskId = String(event.taskId || '').trim();
      // A record with no id could never be retired and would wait forever.
      if (!taskId || !status.startsWith('background-')) return;
      if (status === 'background-started' || status === 'background-running') {
        liveTasks.add(taskId);
        const previous = liveTaskDetails.get(taskId) || {};
        const taskType = String(event.taskType || '').trim();
        const message = String(event.message || '').trim();
        liveTaskDetails.set(taskId, {
          ...(taskType ? { taskType } : previous.taskType ? { taskType: previous.taskType } : {}),
          ...(message ? { message } : previous.message ? { message: previous.message } : {}),
        });
      } else {
        liveTasks.delete(taskId);
        liveTaskDetails.delete(taskId);
      }
    };
    let backgroundTimer: NodeJS.Timeout | null = null;
    let gracefulStopTimer: NodeJS.Timeout | null = null;
    let stopping = false;
    let backgroundTimedOut = false;
    let backgroundRegistered = false;

    const clearBackgroundTimer = (): void => {
      if (backgroundTimer) {
        clearTimeout(backgroundTimer);
        backgroundTimer = null;
      }
    };

    let interrupts = 0;
    const sendInterrupt = (): Promise<void> => {
      interrupts += 1;
      return writeInputRecord({
        type: 'control_request',
        request_id: `orkas-interrupt-${startedAt}-${interrupts}`,
        request: { subtype: 'interrupt' },
      }).catch(() => { /* stdin already gone; callers have their own fallback */ });
    };

    /** Ask the CLI to settle in-flight inference and persist a clean session
     *  state, then reap on the existing path. A process SIGTERM'd mid-turn
     *  leaves a half-written session that swallows the user's next message on
     *  resume; the interrupt is what avoids that. */
    const gracefulStop = (reason: string): void => {
      if (stopping || exited) return;
      stopping = true;
      clearBackgroundTimer();
      watchdog.disarm();
      log.info('claude background run stopping', {
        reason, durationMs: Date.now() - startedAt, liveTasks: liveTasks.size,
      });
      void sendInterrupt();
      gracefulStopTimer = setTimeout(
        () => reapCliAfterProtocolTerminal(child),
        GRACEFUL_STOP_MS,
      );
      if (typeof gracefulStopTimer.unref === 'function') gracefulStopTimer.unref();
    };

    /** User Stop is stronger than a phase timeout: send Claude its protocol
     *  interrupt and close stdin, but also terminate the entire process tree so
     *  a background shell cannot survive after Orkas reports cancellation. */
    const abortNow = (): void => {
      if (stopping || exited) return;
      stopping = true;
      clearBackgroundTimer();
      watchdog.disarm();
      log.info('claude run aborted', {
        phase, durationMs: Date.now() - startedAt, liveTasks: liveTasks.size,
      });
      let interruptGrace: NodeJS.Timeout | null = null;
      let terminated = false;
      const terminateTree = (): void => {
        if (terminated) return;
        terminated = true;
        if (interruptGrace) clearTimeout(interruptGrace);
        try { child.stdin.end(); } catch { /* already closed */ }
        killProcessTree(child, 'SIGTERM');
        const hardKill = setTimeout(() => killProcessTree(child, 'SIGKILL'), 10_000);
        if (typeof hardKill.unref === 'function') hardKill.unref();
      };
      // Let the small protocol interrupt reach Claude first so it can persist a
      // resumable session, but never let stdin backpressure delay Stop beyond a
      // short bounded grace before the process-tree signal wins.
      void sendInterrupt().finally(terminateTree);
      interruptGrace = setTimeout(terminateTree, 100);
      if (typeof interruptGrace.unref === 'function') interruptGrace.unref();
    };

    const onAbort = (): void => abortNow();
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    const detachAbort = (): void => opts.signal.removeEventListener('abort', onAbort);

    /** Exactly one terminal event per run, at the true end of the continuous
     *  foreground/background turn. */
    const emitDone = (
      status: 'completed' | 'failed' | 'cancelled' | 'timeout',
      extra: Partial<LocalEvent> = {},
    ): void => {
      if (doneEmitted) return;
      doneEmitted = true;
      opts.onEvent({
        type: 'done',
        status,
        durationMs: Date.now() - startedAt,
        sessionId,
        ...extra,
      });
    };

    const isForegroundActivity = (event: LocalEvent): boolean => {
      if (
        event.type === 'text-delta'
        || event.type === 'thinking'
        || event.type === 'tool-event'
        || event.type === 'permission-request'
      ) return true;
      if (event.type !== 'status') return false;
      const status = String(event.status || '').toLowerCase();
      return [
        'running', 'retrying', 'usage', 'authenticating', 'rate-limit',
        'waiting-approval', 'waiting-input',
      ].includes(status);
    };

    const enterForeground = (): void => {
      if (phase === 'foreground' || stopping || exited) return;
      phase = 'foreground';
      clearBackgroundTimer();
      // Foreground and background share the dispatch watchdog and deadline.
      log.info('claude background run resumed foreground', {
        durationMs: Date.now() - startedAt,
        liveTasks: liveTasks.size,
      });
    };

    const enterBackground = (): void => {
      if (phase === 'background' || stopping || exited) return;
      phase = 'background';
      const timeoutMs = Math.max(0, Math.min(backgroundTimeoutMs(), deadlineAt - Date.now()));
      // Retain the explicit shortened probe override, never a second default
      // production budget. Re-entering this phase cannot move the run deadline.
      if (backgroundTimeoutMs() < CLAUDE_BACKGROUND_TIMEOUT_MS) {
        backgroundTimer = setTimeout(() => {
          backgroundTimedOut = true;
          gracefulStop('background timeout');
        }, timeoutMs);
        backgroundTimer.unref?.();
      }
      log.info('claude run entered background phase', {
        timeoutMs,
        liveTasks: liveTasks.size,
      });
      // App shutdown still needs an addressable stop handle. Unlike the old
      // post-turn handoff, this does not end the host turn or transfer event
      // ownership; run() remains pending until the real terminal boundary.
      if (!backgroundRegistered) {
        backgroundRegistered = true;
        try {
          opts.onBackgroundRun?.({
            untilProcessExit: new Promise<void>(resolve => {
              child.once('close', () => resolve());
            }),
            stop: gracefulStop,
            liveTasks: () => liveTasks.size,
          });
        } catch (err) {
          log.warn('claude background stop registration rejected by host', {
            error: logErrorSummary(err),
          });
        }
      }
    };

    /** Every stream event stays on the same host turn. Real model/tool activity
     *  resumes foreground presentation without resetting either run budget. */
    const emit = (event: LocalEvent): void => {
      trackTask(event);
      opts.onEvent(event);
      if (phase === 'background' && isForegroundActivity(event)) enterForeground();
    };

    // Build and send the single user message, but keep stdin OPEN —
    // claude code's stream-json protocol uses stdin for two channels:
    //   1. The user message that kicks off the turn (one and done).
    //   2. `control_response` records replying to claude's
    //      `control_request` (tool-use permission, hook gates). The CLI
    //      can send these under its inherited policy or an explicit Orkas
    //      policy, and the process blocks
    //      waiting for a stdin response we never send if we close
    //      stdin here. That's the "silent hang for 20 minutes" symptom
    //      users report — fix by writing the prompt without `.end()`
    //      and closing/reaping the process only once we see the terminal
    //      `result` record.
    const initialInput = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: opts.prompt }],
      },
    };
    void writeInputRecord(initialInput).catch((err) => {
      // A spawn failure closes stdin and reports its own terminal error. Do not
      // turn the resulting asynchronous EPIPE into a second, misleading warning.
      if (!exited) {
        log.warn('claude initial input write failed', { error: logErrorSummary(err) });
      }
    });

    /** Serialize native approval requests so two concurrent tool gates cannot
     * overtake each other while the renderer is waiting for a decision. */
    let permissionResponseQueue = Promise.resolve();
    const userInputRequests = new Map<string, AbortController>();
    const cancelUserInputs = (): void => {
      for (const controller of userInputRequests.values()) controller.abort();
      userInputRequests.clear();
    };
    const respondToControlRequest = async (msg: any, inputSignal?: AbortSignal): Promise<void> => {
      if (exited || inputSignal?.aborted) return;
      const req = msg?.request || {};
      const inputMap = (req.input && typeof req.input === 'object') ? req.input : {};
      if (req.subtype === 'can_use_tool' && req.tool_name === 'AskUserQuestion') {
        const original = Array.isArray(inputMap.questions) ? inputMap.questions : [];
        const questions = original.slice(0, 4).map((question: any, index: number) => ({
          id: `question-${index}`,
          question: typeof question?.question === 'string' ? question.question : '',
          header: typeof question?.header === 'string' ? question.header : undefined,
          options: (Array.isArray(question?.options) ? question.options : [])
            .filter((option: any) => typeof option?.label === 'string')
            .map((option: any) => ({ label: option.label, description: option.description })),
          multiSelect: question?.multiSelect === true,
          isOther: true,
        }));
        let answer: import('./base').LocalCliUserInputResponse = { cancelled: true, answers: {} };
        if (questions.length && questions.every((question: { question: string }) => question.question)
            && opts.requestUserInput) {
          try {
            answer = await opts.requestUserInput({ id: String(msg.request_id || ''), questions, isBlocking: true, signal: inputSignal });
          } catch (err) {
            log.warn('claude user-input request failed', { error: logErrorSummary(err) });
          }
        }
        if (inputSignal?.aborted || exited) return;
        const answered = !answer.cancelled && questions.length > 0
          && questions.every((question: { id: string }) => answer.answers[question.id]?.some(value => value.trim()));
        const answers = Object.fromEntries(questions.map((question: { id: string; question: string }) => [
          question.question, (answer.answers[question.id] || []).join(', '),
        ]));
        await writeInputRecord({
          type: 'control_response',
          response: {
            subtype: 'success', request_id: msg.request_id,
            response: answered
              ? { behavior: 'allow', updatedInput: { ...inputMap, answers } }
              : { behavior: 'deny', message: 'The user did not answer this question.' },
          },
        });
        emit({ type: 'status', status: 'running' });
        return;
      }
      const fullAccess = opts.permissionPolicy === 'full_access';
      let decision: LocalCliPermissionDecision = fullAccess ? 'allow_once' : 'deny';
      if (!fullAccess && opts.requestPermission) {
        try {
          decision = await opts.requestPermission({
            id: String(msg.request_id || ''),
            tool: String(req.tool_name || req.subtype || ''),
            description: typeof req.description === 'string' ? req.description : undefined,
            command: typeof inputMap.command === 'string' ? inputMap.command : undefined,
            subject: typeof inputMap.file_path === 'string'
              ? inputMap.file_path
              : typeof inputMap.path === 'string'
                ? inputMap.path
                : typeof inputMap.url === 'string' ? inputMap.url : undefined,
          });
        } catch (err) {
          log.warn('claude host permission request failed; denying', { error: logErrorSummary(err) });
        }
      }
      const allowed = decision !== 'deny';
      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: allowed
            ? { behavior: 'allow', updatedInput: inputMap }
            : { behavior: 'deny', message: 'The user denied this permission request.' },
        },
      };
      await writeInputRecord(response).catch((err) => {
        log.warn('claude control_response write failed', { error: logErrorSummary(err) });
      });
      emit({
        type: 'permission-request',
        id: String(msg.request_id || ''),
        tool: String(req.tool_name || ''),
        input: inputMap,
        ...(fullAccess
          ? { autoDecided: 'allow', reason: 'full_access' }
          : { decision: allowed ? 'allow' : 'deny', reason: 'user' }),
      });
    };

    // stdout: line-buffered JSON parsing.
    const splitter = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk, line => {
        if (exited) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: any;
        try { obj = JSON.parse(trimmed); }
        catch {
          // Non-JSON stdout — two distinct paths:
          //   - Before sessionId: surface as text-delta so a pre-stream
          //     banner / startup error still lands in the user bubble
          //     even when the CLI never gets far enough to talk
          //     stream-json. This is the only signal the user has when
          //     the CLI itself failed to boot.
          //   - After sessionId: emit as raw-line. Banner, MCP startup
          //     warnings, --verbose debug noise — direct-terminal users
          //     see these every run; previously we dropped them
          //     silently after session_id was captured, which is the
          //     "Orkas shows less than the terminal" symptom users
          //     reported. Raw-line renders as a kind-meta row in the
          //     process rail.
          if (!sessionId) emit({ type: 'text-delta', text: trimmed + '\n' });
          else emit({ type: 'raw-line', line: trimmed });
          return;
        }
        // Side-channel: control_request needs a stdin write back AND a
        // rail event. Handled outside mapClaudeEvent so the mapper
        // stays a pure translator (no I/O, easier to unit-test).
        if (obj?.type === 'control_request') {
          const inputController = obj.request?.subtype === 'can_use_tool' && obj.request?.tool_name === 'AskUserQuestion'
            ? new AbortController() : undefined;
          if (inputController) userInputRequests.set(obj.request_id, inputController);
          permissionResponseQueue = permissionResponseQueue
            .then(() => respondToControlRequest(obj, inputController?.signal))
            .catch((err) => {
              log.warn('claude permission response failed', { error: logErrorSummary(err) });
            }).finally(() => {
              if (inputController && userInputRequests.get(obj.request_id) === inputController) {
                userInputRequests.delete(obj.request_id);
              }
            });
          return;
        }
        if (obj?.type === 'control_cancel_request') {
          userInputRequests.get(obj.request_id)?.abort();
          userInputRequests.delete(obj.request_id);
          return;
        }
        // Side-channel: each `assistant` block carries a `message.usage`
        // snapshot for that turn-piece. Multica accumulates these per
        // model and reports a flat total at the end. We do the same
        // accumulation AND additionally emit a streaming
        // `status:'usage'` event so the rail shows a live token
        // counter (matches the codex / opencode parity — claude only
        // emits one usage record otherwise, at the terminal result).
        if (obj?.type === 'assistant' && obj?.message?.usage) {
          const inc = extractClaudeUsage({ usage: obj.message.usage, message: { model: obj.message.model } });
          if (inc) {
            accUsage = mergeUsage(accUsage, inc);
            emit({ type: 'status', status: 'usage', usage: accUsage });
          }
        }
        const ev = mapClaudeEvent(obj, sessionId, partialState);
        const hadSession = !!sessionId;
        if (ev?.captureSession && obj.session_id) sessionId = String(obj.session_id);
        if (obj?.session_id && !sessionId) sessionId = String(obj.session_id);
        if (!hadSession && sessionId) publishActiveIngress(true);
        if (ev?.events) {
          for (const event of ev.events) emit(event);
        } else if (ev?.event) {
          emit(ev.event);
        }
        if (ev?.terminal) {
          resultStatus = ev.terminal.status;
          resultText = ev.terminal.text;
          // Preserve each canonical result exactly as Claude returned it. The
          // multi-phase join adds only the boundary between turns; ordinary
          // one-result runs must not acquire a whitespace normalization.
          if (resultText.trim()) completedTurnTexts.push(resultText);
          resultError = ev.terminal.error;
          resultUsage = ev.terminal.usage as typeof resultUsage;
          const combinedOutput = completedTurnTexts.join('\n\n');
          const terminalExtra = {
            output: combinedOutput,
            ...(resultError ? { error: resultError, stderrTail: tail.toString() } : {}),
            ...(resultUsage || accUsage ? { usage: resultUsage || accUsage } : {}),
          };
          // Partial-message support is turn-scoped inside one long-lived
          // stream-json process. A later self-woken turn may fall back to full
          // assistant blocks even when the previous turn streamed deltas.
          partialState.sawTextStreamEvent = false;
          // Tool calls never span turns; drop any callId whose result
          // never arrived so the map stays turn-scoped.
          partialState.toolNamesByCallId?.clear();
          if (liveTasks.size > 0) {
            enterBackground();
            // `result` would otherwise be the latest activity row. Reassert the
            // phase after it so the always-visible label tells the user why the
            // reply remains loading even when Claude emits no task_progress.
            const activeTaskId = liveTasks.values().next().value as string | undefined;
            const activeTask = activeTaskId ? liveTaskDetails.get(activeTaskId) : undefined;
            emit({
              type: 'status',
              status: 'background-running',
              taskId: activeTaskId,
              ...(activeTask?.taskType ? { taskType: activeTask.taskType } : {}),
              ...(activeTask?.message ? { message: activeTask.message } : {}),
            });
          } else {
            closingForTerminal = true;
            if (opts.signal.aborted) {
              finishRun('cancelled');
            } else if (backgroundTimedOut) {
              finishRun('timeout', {
                error: `claude timed out: exceeded ${backgroundTimeoutMs()}ms background cap`,
                timeoutPhase: 'background',
                timeoutKind: 'wall',
                stderrTail: tail.toString(),
              });
            } else if (watchdog.fired()) {
              finishRun('timeout', {
                error: `claude ${watchdog.reason()}`,
                timeoutKind: watchdog.fired(),
                timeoutPhase: phase,
                stderrTail: tail.toString(),
              });
            } else {
              finishRun(resultStatus, terminalExtra);
            }
            // The result record is the authoritative terminal boundary. Do not
            // keep Orkas loading while an inherited stdio pipe delays the CLI
            // process's close event.
            reapCliAfterProtocolTerminal(child);
          }
        }
      });
    });
    child.stdout.on('end', () => splitter.flush(line => {
      if (exited) return;
      const trimmed = line.trim();
      if (trimmed) emit({ type: 'text-delta', text: trimmed });
    }));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (exited) return;
      tail.push(chunk);
      // Emit one event per stderr line so live UI can show progress.
      for (const line of chunk.split(/\r?\n/)) {
        if (line) emit({ type: 'stderr-line', line });
      }
    });

    return new Promise<void>(resolve => {
      const finish = (status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Partial<LocalEvent> = {}) => {
        if (exited) return;
        publishActiveIngress(false);
        exited = true;
        cancelUserInputs();
        clearBackgroundTimer();
        if (gracefulStopTimer) {
          clearTimeout(gracefulStopTimer);
          gracefulStopTimer = null;
        }
        watchdog.disarm();
        detachAbort();
        emitDone(status, extra);
        resolve();
      };
      finishRun = finish;

      child.on('error', err => {
        log.warn('claude spawn error', { error: logErrorSummary(err) });
        finish('failed', {
          error: (err as Error).message,
          stderrTail: tail.toString(),
          failureKind: 'cli_spawn',
          retrySafe: true,
        });
      });
      child.on('close', code => {
        if (backgroundRegistered) {
          log.info('claude background process closed', {
            code, stopping, durationMs: Date.now() - startedAt, liveTasks: liveTasks.size,
          });
        }
        if (opts.signal.aborted) return finish('cancelled');
        if (backgroundTimedOut) {
          return finish('timeout', {
            error: `claude timed out: exceeded ${backgroundTimeoutMs()}ms background cap`,
            timeoutPhase: 'background',
            timeoutKind: 'wall',
            stderrTail: tail.toString(),
          });
        }
        if (watchdog.fired()) {
          return finish('timeout', {
            error: `claude ${watchdog.reason()}`,
            timeoutKind: watchdog.fired(),
            timeoutPhase: phase,
            stderrTail: tail.toString(),
          });
        }
        const combinedOutput = completedTurnTexts.join('\n\n');
        if ((code === 0 || closingForTerminal) && resultStatus === 'completed') {
          return finish('completed', { output: combinedOutput, usage: resultUsage });
        }
        // Non-zero exit OR result subtype indicated error — surface tail.
        const err = resultError
          || (code !== 0 ? `claude exited with code ${code}` : 'claude reported error in result');
        finish('failed', { error: err, output: combinedOutput, stderrTail: tail.toString(), usage: resultUsage });
      });
    });
  },
};

/** Args mirroring the multica skeleton, distilled to what we actually
 *  use in v1: stream-json in/out and `--print` (non-interactive). Missing
 *  model/effort/permission overrides deliberately leave selection to Claude
 *  Code when the Agent has no explicit value. */
export function buildClaudeArgs(opts: Pick<BackendRunOptions,
  'resumeSessionId' | 'customArgs' | 'bridge' | 'systemPrompt' | 'modelOverride' | 'thinkingLevel' | 'permissionPolicy'
>): string[] {
  // `--include-partial-messages` is the flag that turns claude code's
  // stream-json output from "one assistant message per completed turn"
  // into "many partial chunks streamed as the model generates". Without
  // it the user sees nothing for tens of seconds and then everything
  // appears at once — same UX as a non-streaming request. Older claude
  // versions silently ignore the flag rather than erroring on it.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--include-hook-events',
    '--verbose',
    // The response transport is also required for AskUserQuestion under
    // inherited/full-access policies; the CLI still owns permission mode.
    '--permission-prompt-tool', 'stdio',
    ...buildClaudePermissionArgs(opts.permissionPolicy || 'inherit'),
  ];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.modelOverride) args.push('--model', opts.modelOverride);
  if (opts.thinkingLevel) args.push('--effort', opts.thinkingLevel);
  // orkas-bridge: ADD the per-run MCP server alongside the user's own MCP
  // config (no --strict-mcp-config — their servers must keep working), and
  // tell the agent the bridge exists via an appended system prompt.
  if (opts.bridge) {
    args.push('--mcp-config', opts.bridge.mcpConfigPath);
  }
  const appendedSystemPrompt = [
    opts.systemPrompt,
    opts.bridge?.appendSystemPrompt,
  ].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
  // Claude Code treats append-system-prompt as invocation-scoped: a resumed
  // process does not recover an omitted append from the saved conversation.
  // Keep the stable bundle byte-identical, but pass it on every invocation.
  if (appendedSystemPrompt) {
    args.push('--append-system-prompt', appendedSystemPrompt);
  }
  if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
  return args;
}

export function buildClaudePermissionArgs(
  policy: NonNullable<BackendRunOptions['permissionPolicy']>,
): string[] {
  if (policy === 'ask') {
    return ['--permission-mode', 'default'];
  }
  if (policy === 'full_access') {
    return ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'];
  }
  return [];
}

/** Translate one parsed claude stream-json record into our event model.
 *  Returns `undefined` when the record is recognized but produces no
 *  user-visible event (e.g. system/init that only seeds the session id).
 *
 *  Two parallel input shapes:
 *    - `type:'stream_event'` — partial-message tokens emitted only when
 *      `--include-partial-messages` is on. These are what give us real
 *      token-by-token streaming; we map their deltas to text-delta /
 *      thinking events.
 *    - `type:'assistant'` — the full message that aggregates everything
 *      streamed above. Emitted at end-of-turn. We **skip text/thinking
 *      content here** (the partials already covered it) but DO surface
 *      tool_use blocks because the partial input_json deltas alone
 *      aren't enough to render a useful tool-event.
 */
export type ClaudeParseState = {
  sawTextStreamEvent: boolean;
  /** callId -> tool name, captured from the assistant `tool_use` block so the
   *  `tool_result` branch can tell agent-produced media apart from a file the
   *  agent merely read. Optional: callers that only care about text (and the
   *  parser tests) may pass a bare `{ sawTextStreamEvent }`. */
  toolNamesByCallId?: Map<string, string>;
};

export function mapClaudeEvent(
  obj: any,
  _sessionIdSoFar: string | undefined,
  partialState: ClaudeParseState = { sawTextStreamEvent: false },
):
  | undefined
  | {
      event?: LocalEvent;
      events?: LocalEvent[];
      captureSession?: boolean;
      terminal?: {
        status: 'completed' | 'failed';
        text: string;
        error?: string;
        usage?: Record<string, number | string>;
      };
    } {
  if (!obj || typeof obj !== 'object') return undefined;
  const type = obj.type;
  if (type === 'system' && obj.subtype === 'init') {
    // Surface a running-status pulse alongside capturing the session
    // id. Matches multica's parity: an explicit '▶ running' row tells
    // the user the CLI handshake succeeded and we're now waiting on
    // model output, distinct from the earlier '▶ /path/to/claude'
    // spawn row.
    return {
      captureSession: true,
      event: { type: 'status', status: 'running' },
    };
  }
  if (type === 'system') {
    const subtype = String(obj.subtype || '');
    if (subtype === 'api_retry') {
      return {
        event: {
          type: 'status',
          status: 'retrying',
          attempt: finitePositiveInteger(obj.attempt),
          maxRetries: finitePositiveInteger(obj.max_retries),
          retryDelayMs: finiteNonNegativeNumber(obj.retry_delay_ms),
          errorStatus: finiteNonNegativeNumber(obj.error_status),
          error: String(obj.error || ''),
        },
      };
    }
    if (subtype === 'status') {
      const status = String(obj.status || '');
      return status ? { event: { type: 'status', status } } : undefined;
    }
    if (subtype === 'compact_boundary') {
      return { event: { type: 'status', status: 'compacted' } };
    }
    if (subtype === 'task_started') {
      return {
        event: {
          type: 'status',
          status: 'background-started',
          taskId: String(obj.task_id || ''),
          taskType: String(obj.task_type || ''),
          message: String(obj.description || ''),
        },
      };
    }
    if (subtype === 'task_progress') {
      return {
        event: {
          type: 'status',
          status: 'background-running',
          taskId: String(obj.task_id || ''),
          taskType: String(obj.subagent_type || ''),
          message: String(obj.summary || obj.description || obj.last_tool_name || ''),
          usage: obj.usage && typeof obj.usage === 'object' ? obj.usage : undefined,
        },
      };
    }
    if (subtype === 'task_notification') {
      const taskStatus = String(obj.status || 'completed').toLowerCase();
      return {
        event: {
          type: 'status',
          status: taskStatus === 'failed'
            ? 'background-failed'
            : (taskStatus === 'stopped' ? 'background-stopped' : 'background-completed'),
          taskId: String(obj.task_id || ''),
          message: String(obj.summary || ''),
          usage: obj.usage && typeof obj.usage === 'object' ? obj.usage : undefined,
        },
      };
    }
    if (subtype === 'task_updated') {
      const patch = obj.patch && typeof obj.patch === 'object' ? obj.patch : {};
      const taskStatus = String(patch.status || '').toLowerCase();
      const normalized = taskStatus === 'completed'
        ? 'background-completed'
        : (taskStatus === 'failed'
            ? 'background-failed'
            : (taskStatus === 'killed' ? 'background-stopped' : 'background-running'));
      return {
        event: {
          type: 'status',
          status: normalized,
          taskId: String(obj.task_id || ''),
          message: String(patch.error || patch.description || ''),
        },
      };
    }
    if (subtype === 'hook_started') {
      return {
        event: {
          type: 'tool-event',
          tool: `hook:${String(obj.hook_name || obj.hook_event || 'hook')}`,
          callId: String(obj.hook_id || ''),
          phase: 'use',
          input: { event: String(obj.hook_event || '') },
        },
      };
    }
    if (subtype === 'hook_progress') {
      return {
        event: {
          type: 'status',
          status: 'tool-progress',
          callId: String(obj.hook_id || ''),
          tool: `hook:${String(obj.hook_name || obj.hook_event || 'hook')}`,
          message: String(obj.output || obj.stdout || obj.stderr || ''),
        },
      };
    }
    if (subtype === 'hook_response') {
      const output = String(obj.output || obj.stdout || obj.stderr || obj.outcome || '');
      return {
        event: {
          type: 'tool-event',
          tool: `hook:${String(obj.hook_name || obj.hook_event || 'hook')}`,
          callId: String(obj.hook_id || ''),
          phase: 'result',
          output,
        },
      };
    }
    if (subtype === 'local_command_output' && typeof obj.content === 'string') {
      return { event: { type: 'text-delta', text: obj.content } };
    }
  }
  if (type === 'tool_progress') {
    return {
      event: {
        type: 'status',
        status: 'tool-progress',
        callId: String(obj.tool_use_id || ''),
        tool: String(obj.tool_name || 'tool'),
        taskId: String(obj.task_id || ''),
        elapsedSeconds: finiteNonNegativeNumber(obj.elapsed_time_seconds),
      },
    };
  }
  if (type === 'auth_status') {
    return {
      event: {
        type: 'status',
        status: obj.error ? 'error' : (obj.isAuthenticating ? 'authenticating' : 'running'),
        message: String(obj.error || (Array.isArray(obj.output) ? obj.output.join('\n') : '')),
      },
    };
  }
  if (type === 'rate_limit_event') {
    const info = obj.rate_limit_info && typeof obj.rate_limit_info === 'object'
      ? obj.rate_limit_info
      : {};
    const rateLimitStatus = String(info.status || '').trim().toLowerCase();
    return {
      event: {
        type: 'status',
        // Claude emits this event whenever its rate-limit information changes,
        // including allowed and early-warning states. Only `rejected` means
        // the current request cannot continue; keep every other state in the
        // persisted usage stream without painting a user-facing warning.
        status: rateLimitStatus === 'rejected' ? 'rate-limit' : 'usage',
        rateLimitStatus,
        resetsAt: finiteNonNegativeNumber(info.resetsAt),
        utilization: finiteNonNegativeNumber(info.utilization),
      },
    };
  }
  if (type === 'log') {
    // claude --verbose emits these for MCP / hook / tool-router
    // internals. We used to drop them as an unknown type; they're
    // exactly the "why is the CLI silent for 20s" signal users were
    // missing.
    const lvl = obj?.log?.level || obj?.level;
    const msg = obj?.log?.message || obj?.message || '';
    if (typeof msg !== 'string' || !msg) return undefined;
    return {
      event: {
        type: 'log',
        level: levelOrInfo(lvl),
        message: msg,
        source: 'claude',
      },
    };
  }
  if (type === 'stream_event') {
    const inner = obj.event;
    if (!inner || typeof inner !== 'object') return undefined;
    const innerType = inner.type;
    if (innerType === 'content_block_delta') {
      const d = inner.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length) {
        partialState.sawTextStreamEvent = true;
        return { event: { type: 'text-delta', text: d.text } };
      }
      if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking.length) {
        return { event: { type: 'thinking', text: d.thinking } };
      }
      // input_json_delta carries tool input streamed character-by-
      // character. Useless to render incrementally; we let the
      // assistant block fold it together when the turn finishes.
      return undefined;
    }
    if (innerType === 'content_block_start') {
      // content_block_start for a tool_use ALWAYS has an empty `input`
      // here — claude streams the actual input character-by-character
      // through `input_json_delta` notifications and folds them at
      // content_block_stop / in the assistant block. Emitting the
      // start event surfaced as a confusing `■ Bash · 开始 · {}`
      // duplicate of the proper `■ Bash · 开始 · {"command":...}` row
      // the assistant block produces a few hundred ms later.
      // Same reason `input_json_delta` is intentionally not rendered
      // (see the content_block_delta branch above) — we wait for the
      // assistant block to emit one row with the complete input.
      return undefined;
    }
    return undefined;
  }
  if (type === 'assistant') {
    const content = Array.isArray(obj?.message?.content) ? obj.message.content : [];
    const events: LocalEvent[] = [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        // Already streamed via stream_event partials → skip to avoid
        // duplicating the body. If the CLI didn't honor the partial
        // flag (older versions), no stream_event with text fired and
        // we fall back to emitting it here so the user still sees the
        // reply.
        if (!partialState.sawTextStreamEvent) {
          events.push({ type: 'text-delta', text: part.text });
        }
        continue;
      }
      if (part?.type === 'thinking') {
        if (!partialState.sawTextStreamEvent && typeof part.thinking === 'string') {
          events.push({ type: 'thinking', text: part.thinking });
        }
        continue;
      }
      if (part?.type === 'tool_use') {
        const useCallId = String(part.id || '');
        const useToolName = String(part.name || 'unknown');
        // Recorded so the matching tool_result can classify any image it
        // carries. Consumed (and deleted) there; cleared at turn end.
        if (useCallId && partialState.toolNamesByCallId) {
          partialState.toolNamesByCallId.set(useCallId, useToolName);
        }
        events.push({
            type: 'tool-event',
            tool: useToolName,
            callId: useCallId,
            phase: 'use',
            input: part.input ?? {},
        });
      }
    }
    return packClaudeEvents(events);
  }
  if (type === 'user') {
    const content = Array.isArray(obj?.message?.content) ? obj.message.content : [];
    const events: LocalEvent[] = [];
    for (const part of content) {
      if (part?.type === 'tool_result') {
        const out = typeof part.content === 'string'
          ? part.content
          : Array.isArray(part.content)
            ? part.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
            : '';
        const callId = String(part.tool_use_id || '');
        events.push({
            type: 'tool-event',
            tool: 'tool_result',
            callId,
            phase: 'result',
            output: out,
        });
        const mediaItems = claudeToolResultImages(part.content);
        const originTool = callId
          ? partialState.toolNamesByCallId?.get(callId) || ''
          : '';
        if (callId) partialState.toolNamesByCallId?.delete(callId);
        // `Read` returns the file itself as an image block. Publishing that
        // republished whatever the agent looked at — including the user's own
        // upload — as `![generated image]`.
        if (mediaItems.length && !isFileReadToolName(originTool)) {
          events.push({
            type: 'media-output',
            source: 'claude',
            callId,
            items: mediaItems,
          });
        }
      }
    }
    return packClaudeEvents(events);
  }
  if (type === 'result') {
    const ok = obj.subtype === 'success';
    const text = typeof obj.result === 'string' ? obj.result : '';
    const error = !ok
      ? (
          typeof obj.error === 'string'
            ? obj.error
            : (Array.isArray(obj.errors)
                ? obj.errors.map((entry: unknown) => String(entry || '')).filter(Boolean).join('\n')
                : undefined)
        )
      : undefined;
    // Extract usage in the same shape multica daemon does
    // (input_tokens / output_tokens / cache_read_input_tokens /
    // cache_creation_input_tokens). Model lives on the message
    // sibling sometimes; fall back to root `model` if present.
    const usage = extractClaudeUsage(obj);
    // Carry usage on the status event too so the rail can render
    // "● result · in=N out=M cache=K" at turn end — claude only emits
    // usage once (not streaming like codex/opencode), so without this
    // the rail's last row is a bare `● result` and the user has no
    // sense of how much the turn cost. The terminal record carries it
    // alongside for the done event path.
    return {
      event: {
        type: 'status',
        status: ok ? 'result' : 'error',
        ...(usage ? { usage } : {}),
      },
      terminal: { status: ok ? 'completed' : 'failed', text, error, usage },
    };
  }
  return undefined;
}

function packClaudeEvents(events: LocalEvent[]): undefined | { event: LocalEvent; events?: LocalEvent[] } {
  if (!events.length) return undefined;
  return events.length === 1
    ? { event: events[0] }
    : { event: events[0], events };
}

function claudeToolResultImages(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((block): Array<Record<string, string>> => {
    if (!block || typeof block !== 'object' || block.type !== 'image') return [];
    const source = block.source;
    if (!source || typeof source !== 'object') return [];
    const mediaType = typeof source.media_type === 'string' ? source.media_type.trim() : '';
    if (source.type === 'base64' && typeof source.data === 'string' && source.data.trim()) {
      return [{ data: source.data.trim(), ...(mediaType ? { mediaType } : {}) }];
    }
    if (source.type === 'url' && typeof source.url === 'string' && source.url.trim()) {
      return [{ uri: source.url.trim(), ...(mediaType ? { mediaType } : {}) }];
    }
    return [];
  });
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const n = finiteNonNegativeNumber(value);
  return n !== undefined && n > 0 ? Math.round(n) : undefined;
}

/** Pull token-usage fields out of a claude-code `type:result` record
 *  into our normalized shape. Returns undefined when no recognizable
 *  numeric fields are present so the caller can omit the `usage` key
 *  rather than emit zeros. Exposed for unit testing.
 *
 *  Reads from THREE root fields:
 *    - `usage.{input,output,cache_read,cache_creation}_input_tokens`
 *    - `total_cost_usd` (claude tracks the dollars itself)
 *    - `message.model` / `model` (string)
 */
export function extractClaudeUsage(obj: any): undefined | {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  cost?: number;
  model?: string;
} {
  const u = obj?.usage;
  const haveUsage = u && typeof u === 'object';
  const out: Record<string, number | string> = {};
  if (haveUsage) {
    if (typeof u.input_tokens === 'number') out.input = u.input_tokens;
    if (typeof u.output_tokens === 'number') out.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') out.cacheCreate = u.cache_creation_input_tokens;
  }
  if (typeof obj?.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)) {
    out.cost = obj.total_cost_usd;
  }
  const model = obj?.message?.model || obj?.model;
  if (typeof model === 'string' && model) out.model = model;
  return Object.keys(out).length ? (out as any) : undefined;
}

/** Sum two normalized usage records numeric-field-wise. `model` follows
 *  last-write-wins (multi-model turns are rare but possible). Used by
 *  the claude backend to accumulate per-`assistant`-block snapshots
 *  into a running total — exposed via `status:'usage'` events so the
 *  rail shows a live token counter without waiting for the terminal
 *  result record. Mirrors multica's per-model usage map (we collapse
 *  to a single flat record since the rail only renders one usage row). */
function mergeUsage(
  acc: Record<string, number | string> | undefined,
  inc: Record<string, number | string>,
): Record<string, number | string> {
  const out: Record<string, number | string> = { ...(acc || {}) };
  for (const k of ['input', 'output', 'cacheRead', 'cacheCreate']) {
    const a = typeof out[k] === 'number' ? (out[k] as number) : 0;
    const i = typeof inc[k] === 'number' ? (inc[k] as number) : 0;
    if (a || i) out[k] = a + i;
  }
  if (typeof inc.model === 'string' && inc.model) out.model = inc.model;
  return out;
}
