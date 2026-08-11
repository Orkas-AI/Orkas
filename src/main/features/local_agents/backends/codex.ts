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
import { logErrorSummary } from '../../../util/log-redact.js';
import {
  type LocalBackend,
  type LocalActiveRunIngress,
  type LocalActiveRunInput,
  type BackendRunOptions,
  type LocalEvent,
  StderrTail,
  spawnCli,
  killProcessTree,
  reapCliAfterProtocolTerminal,
  bindAbort,
  armKillWatchdog,
  LineSplitter,
  stripAnsi,
} from './base.js';
import {
  normalizeLocalTextPhase,
  type LocalTextPhase,
} from '../text-phase.js';

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

/** Notifications that must not cross into the process rail or persisted
 * history. Host metadata may contain machine-private identifiers. Streaming
 * command/file/reasoning deltas can arrive once per progress character, such
 * as unittest's "." output, so forwarding them as unknown info logs creates
 * hundreds of noisy rows. Command deltas and raw reasoning text are consumed
 * separately as content-free liveness below. Model-authored reasoning summaries
 * use their own bounded public event path; the remaining notifications drop. */
const CODEX_IGNORED_NOTIFICATIONS = new Set<string>([
  'remoteControl/status/changed',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
]);

const log = createLogger('local-agents:codex');

/** Keep a quiet-but-active Codex item below the runner's 90s idle-warning
 * window without putting every token or stdout byte into history. Heartbeats
 * carry no reasoning/command content and are excluded from persisted chat
 * process items by the group-chat bridge. */
export const CODEX_ACTIVITY_HEARTBEAT_MS = 30_000;

interface CodexReasoningState {
  itemSummary: string;
  streamedSummary: string;
  partSummaries: string[];
  rawChars: number;
}

function codexReasoningSummaryText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(part => codexReasoningSummaryText(part))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (value && typeof value === 'object') {
    const part = value as Record<string, unknown>;
    if (typeof part.text === 'string') return part.text.trim();
  }
  return '';
}

export class CodexActivityHeartbeat {
  private readonly reasoning = new Set<string>();
  private readonly commands = new Set<string>();

  startReasoning(itemId: string): boolean {
    if (!itemId || this.reasoning.has(itemId)) return false;
    this.reasoning.add(itemId);
    return true;
  }

  startCommand(itemId: string): boolean {
    if (!itemId || this.commands.has(itemId)) return false;
    this.commands.add(itemId);
    return true;
  }

  complete(itemId: string): void {
    if (!itemId) return;
    this.reasoning.delete(itemId);
    this.commands.delete(itemId);
  }

  pulseEvents(): LocalEvent[] {
    return [
      ...Array.from(this.reasoning, itemId => ({
        type: 'thinking' as const,
        chars: 0,
        itemId,
        heartbeat: true,
        synthetic: true,
      })),
      ...Array.from(this.commands, callId => ({
        type: 'status' as const,
        status: 'tool-progress',
        tool: 'exec_command',
        callId,
        heartbeat: true,
        synthetic: true,
      })),
    ];
  }
}

const TRUSTED_LOCAL_APPROVAL_POLICY = 'never';
const TRUSTED_LOCAL_SANDBOX_MODE = 'danger-full-access';
const TRUSTED_LOCAL_SANDBOX_POLICY = { type: 'dangerFullAccess' } as const;

/** Tracks the phase and streamed body of Codex `agentMessage` items. Delta
 * notifications carry only itemId + text, while the phase lives on the
 * matching item/started or item/completed payload. Keeping this as a small
 * pure accumulator makes version-skew fallbacks deterministic and testable. */
export class CodexAgentMessageAccumulator {
  private readonly phases = new Map<string, LocalTextPhase>();
  private readonly streamedByItem = new Map<string, string>();
  private allText = '';
  private finalAnswerText = '';

  rememberItem(raw: unknown): void {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (item.type !== 'agentMessage') return;
    const itemId = typeof item.id === 'string' ? item.id : '';
    const phase = normalizeLocalTextPhase(item.phase);
    if (itemId && phase) this.phases.set(itemId, phase);
  }

  appendDelta(raw: unknown): { text: string; itemId?: string; phase?: LocalTextPhase } | null {
    const params = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const text = typeof params.delta === 'string' ? params.delta : '';
    if (!text) return null;
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    return this.append(text, itemId, normalizeLocalTextPhase(params.phase) || this.phases.get(itemId));
  }

  appendCompletedFallback(raw: unknown): { text: string; itemId?: string; phase?: LocalTextPhase } | null {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (item.type !== 'agentMessage') return null;
    this.rememberItem(item);
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text) return null;
    const itemId = typeof item.id === 'string' ? item.id : '';
    const streamed = itemId ? (this.streamedByItem.get(itemId) || '') : '';
    if (streamed === text) return null;
    // Some Codex builds omit the last delta but include the complete item on
    // completion. Emit only the missing suffix. If the bodies disagree, keep
    // the live stream authoritative rather than duplicating the whole item.
    if (streamed && !text.startsWith(streamed)) return null;
    const suffix = streamed ? text.slice(streamed.length) : text;
    const phase = this.phases.get(itemId) || normalizeLocalTextPhase(item.phase);
    return suffix ? this.append(suffix, itemId, phase) : null;
  }

  output(): string {
    return this.finalAnswerText || this.allText;
  }

  hasText(): boolean {
    return this.allText.length > 0;
  }

  private append(
    text: string,
    itemId: string,
    phase?: LocalTextPhase,
  ): { text: string; itemId?: string; phase?: LocalTextPhase } {
    this.allText += text;
    if (phase === 'final_answer') this.finalAnswerText += text;
    if (itemId) this.streamedByItem.set(itemId, (this.streamedByItem.get(itemId) || '') + text);
    return {
      text,
      ...(itemId ? { itemId } : {}),
      ...(phase ? { phase } : {}),
    };
  }
}

/** Translate Codex item variants that represent observable work into the
 * common tool lifecycle. Agent text/reasoning and command/file items retain
 * their dedicated handlers; this covers MCP, dynamic tools, collaboration,
 * background agents, search/media work, sleeps and context compaction. */
export function mapCodexItemToolEvent(
  raw: unknown,
  phase: 'use' | 'result',
): LocalEvent | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const type = String(item.type || '');
  const callId = String(item.id || '');
  let tool = '';
  let input: unknown;
  let output: unknown;

  switch (type) {
    case 'mcpToolCall':
      tool = [String(item.server || 'mcp'), String(item.tool || 'tool')].join('.');
      input = item.arguments ?? {};
      output = item.error ?? item.result ?? item.status ?? '';
      break;
    case 'dynamicToolCall':
      tool = [item.namespace, item.tool].filter(Boolean).map(String).join('.') || 'dynamic_tool';
      input = item.arguments ?? {};
      output = item.contentItems ?? item.success ?? item.status ?? '';
      break;
    case 'collabAgentToolCall':
      tool = `collaboration:${String(item.tool || 'agent')}`;
      input = {
        receiverCount: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0,
        ...(typeof item.prompt === 'string' && item.prompt ? { prompt: item.prompt } : {}),
      };
      output = item.agentsStates ?? item.status ?? '';
      break;
    case 'subAgentActivity':
      tool = 'background_agent';
      input = { kind: item.kind || 'started' };
      output = item.kind || '';
      break;
    case 'webSearch':
      tool = 'web_search';
      input = { query: String(item.query || '') };
      output = item.results ?? item.action ?? '';
      break;
    case 'imageView':
      tool = 'view_image';
      input = { path: String(item.path || '') };
      output = item.status ?? '';
      break;
    case 'imageGeneration':
      tool = 'image_generation';
      input = item.prompt ? { prompt: String(item.prompt) } : {};
      output = item.result ?? item.status ?? '';
      break;
    case 'sleep':
      tool = 'background_wait';
      input = { durationMs: Number(item.durationMs) || 0 };
      output = item.status ?? '';
      break;
    case 'contextCompaction':
      tool = 'context_compaction';
      input = {};
      output = item.status ?? '';
      break;
    default:
      return null;
  }

  return {
    type: 'tool-event',
    tool,
    callId,
    phase,
    ...(phase === 'use' ? { input } : { output }),
  };
}

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
    let activeTurnId: string | undefined;
    let turnStarted = false;
    let turnAborted = false;
    let turnCompleted = false;
    let retryAttempt = 0;
    const seenTurnIds = new Set<string>();
    const agentMessages = new CodexAgentMessageAccumulator();
    const activity = new CodexActivityHeartbeat();
    const reasoningByItem = new Map<string, CodexReasoningState>();
    let turnError: string | undefined;
    // Latest usage snapshot from `thread/tokenUsage/updated` —
    // each notification is a cumulative state (not an increment),
    // so we just overwrite. Threaded into the done event below.
    let lastUsage: Record<string, number | string> | undefined;

    const activityTimer = setInterval(() => {
      if (exited) return;
      for (const event of activity.pulseEvents()) opts.onEvent(event);
    }, CODEX_ACTIVITY_HEARTBEAT_MS);
    if (typeof activityTimer.unref === 'function') activityTimer.unref();

    const sendLine = (msg: object) => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); }
      catch (err) { log.warn('codex stdin write failed', { error: logErrorSummary(err) }); }
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

    const publishActiveIngress = (turnId: string | null): void => {
      activeTurnId = turnId || undefined;
      if (!turnId || !threadId || exited || turnCompleted) {
        try { opts.onActiveRunIngress?.(null); } catch { /* host already gone */ }
        return;
      }
      const ingressThreadId = threadId;
      const ingressTurnId = turnId;
      const ingress: LocalActiveRunIngress = {
        submit: async (input: LocalActiveRunInput) => {
          if (
            exited
            || turnCompleted
            || threadId !== ingressThreadId
            || activeTurnId !== ingressTurnId
          ) {
            return { mode: 'queued_followup', reason: 'codex turn is no longer active' };
          }
          const richInput: Array<Record<string, unknown>> = [];
          const text = String(input.text || '').trim();
          if (text) richInput.push({ type: 'text', text });
          for (const image of input.localImages || []) {
            const imagePath = String(image?.path || '').trim();
            if (imagePath) richInput.push({ type: 'localImage', path: imagePath });
          }
          if (!richInput.length) {
            return { mode: 'rejected', reason: 'empty active-turn input' };
          }
          try {
            const result = await rpc('turn/steer', {
              threadId: ingressThreadId,
              expectedTurnId: ingressTurnId,
              clientUserMessageId: input.id,
              input: richInput,
            });
            const acceptedTurnId = typeof result?.turnId === 'string' ? result.turnId : '';
            if (acceptedTurnId !== ingressTurnId) {
              return {
                mode: 'queued_followup',
                reason: acceptedTurnId
                  ? 'codex acknowledged a different active turn'
                  : 'codex did not acknowledge the active turn',
              };
            }
            return { mode: 'steered', acceptedId: input.id };
          } catch (err) {
            // ActiveTurnNotSteerable, a completed/mismatched expectedTurnId,
            // transport shutdown and version-skew all degrade to the durable
            // worker FIFO. Never acknowledge a message on an uncertain RPC.
            return {
              mode: 'queued_followup',
              reason: (err as Error).message || String(err),
            };
          }
        },
      };
      try { opts.onActiveRunIngress?.(ingress); } catch { /* host already gone */ }
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
          if (!exited) opts.onEvent({ type: 'raw-line', line: trimmed });
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
      if (exited) return;
      const clean = stripAnsi(chunk);
      tail.push(clean);
      for (const line of clean.split(/\r?\n/)) {
        if (line) opts.onEvent({ type: 'stderr-line', line });
      }
    });

    function emitTextDelta(chunk: { text: string; itemId?: string; phase?: LocalTextPhase } | null) {
      if (!chunk?.text) return;
      opts.onEvent({ type: 'text-delta', ...chunk });
    }

    function reasoningState(itemId: string): CodexReasoningState {
      let state = reasoningByItem.get(itemId);
      if (!state) {
        state = { itemSummary: '', streamedSummary: '', partSummaries: [], rawChars: 0 };
        reasoningByItem.set(itemId, state);
      }
      return state;
    }

    function currentReasoningSummary(state: CodexReasoningState): string {
      return state.itemSummary || state.streamedSummary || state.partSummaries.join('\n').trim();
    }

    function emitReasoningActivity(itemId: string, state: CodexReasoningState): void {
      const summary = currentReasoningSummary(state);
      opts.onEvent({
        type: 'thinking',
        chars: summary.length || state.rawChars,
        itemId,
        heartbeat: true,
        ...(summary ? { summary } : {}),
      });
    }

    function completeReasoning(itemId: string, rawItem: unknown): void {
      const item = rawItem && typeof rawItem === 'object'
        ? rawItem as Record<string, unknown>
        : {};
      const state = reasoningState(itemId);
      const completedSummary = codexReasoningSummaryText(item.summary);
      if (completedSummary) state.itemSummary = completedSummary;
      if (typeof item.text === 'string') state.rawChars = Math.max(state.rawChars, item.text.length);
      const summary = currentReasoningSummary(state);
      opts.onEvent({
        type: 'thinking',
        chars: summary.length || state.rawChars,
        itemId,
        ...(summary ? { summary } : {}),
      });
      reasoningByItem.delete(itemId);
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
      if (exited) return;
      const eventThreadId = typeof params.threadId === 'string' ? params.threadId : '';
      if (threadId && eventThreadId && eventThreadId !== threadId) return;

      // Newer Codex builds stream public reasoning summaries separately from
      // raw reasoning text. Summary pulses may update the live activity label,
      // but only the completed aggregate becomes a persisted process row.
      if (method === 'item/reasoning/summaryTextDelta') {
        const itemId = String(params.itemId || 'reasoning');
        activity.startReasoning(itemId);
        const state = reasoningState(itemId);
        if (typeof params.delta === 'string') state.streamedSummary += params.delta;
        emitReasoningActivity(itemId, state);
        return;
      }
      if (method === 'item/reasoning/summaryPartAdded') {
        const itemId = String(params.itemId || 'reasoning');
        activity.startReasoning(itemId);
        const state = reasoningState(itemId);
        const part = codexReasoningSummaryText(params.part);
        if (part && !state.partSummaries.includes(part)) state.partSummaries.push(part);
        emitReasoningActivity(itemId, state);
        return;
      }
      if (method === 'item/reasoning/textDelta') {
        const itemId = String(params.itemId || 'reasoning');
        const state = reasoningState(itemId);
        if (typeof params.delta === 'string') state.rawChars += params.delta.length;
        if (activity.startReasoning(itemId)) emitReasoningActivity(itemId, state);
        return;
      }
      if (method === 'item/commandExecution/outputDelta') {
        const itemId = String(params.itemId || 'command');
        if (activity.startCommand(itemId)) {
          opts.onEvent({
            type: 'status',
            status: 'tool-progress',
            tool: 'exec_command',
            callId: itemId,
            heartbeat: true,
          });
        }
        return;
      }
      if (CODEX_IGNORED_NOTIFICATIONS.has(method)) return;

      // ── Streaming agent text (the important one) ─────────────────
      if (method === 'item/agentMessage/delta') {
        emitTextDelta(agentMessages.appendDelta(params));
        return;
      }

      // ── Lifecycle ────────────────────────────────────────────────
      if (method === 'turn/started') {
        turnStarted = true;
        const startedTurnId = typeof params?.turn?.id === 'string'
          ? params.turn.id
          : (typeof params?.turnId === 'string' ? params.turnId : '');
        if (startedTurnId) publishActiveIngress(startedTurnId);
        opts.onEvent({ type: 'status', status: 'running' });
        return;
      }
      if (method === 'turn/completed') {
        const turn = params?.turn || {};
        const turnId: string = typeof turn?.id === 'string' ? turn.id : '';
        const status: string = typeof turn?.status === 'string' ? turn.status : '';
        if (status === 'inProgress') return;
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
        const itemId = String(item.id || '');
        agentMessages.rememberItem(item);
        if (item.type === 'commandExecution') {
          activity.startCommand(itemId);
          opts.onEvent({
            type: 'tool-event',
            tool: 'exec_command',
            callId: itemId,
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
        } else if (item.type === 'agentReasoning' || item.type === 'reasoning') {
          // Older Codex builds place a user-facing summary on item/started.
          // Raw item.text remains private and contributes only a character
          // count. The completed event below publishes one durable row.
          const reasoningId = itemId || 'reasoning';
          const state = reasoningState(reasoningId);
          const summary = codexReasoningSummaryText(item.summary);
          if (summary) state.itemSummary = summary;
          if (typeof item.text === 'string') state.rawChars = Math.max(state.rawChars, item.text.length);
          activity.startReasoning(reasoningId);
          emitReasoningActivity(reasoningId, state);
        } else {
          const event = mapCodexItemToolEvent(item, 'use');
          if (event) opts.onEvent(event);
        }
        return;
      }
      if (method === 'item/completed') {
        const item = params.item || {};
        const itemId = String(item.id || '');
        activity.complete(itemId || (item.type === 'reasoning' || item.type === 'agentReasoning'
          ? 'reasoning'
          : (item.type === 'commandExecution' ? 'command' : '')));
        agentMessages.rememberItem(item);
        if (item.type === 'commandExecution') {
          opts.onEvent({
            type: 'tool-event',
            tool: 'exec_command',
            callId: itemId,
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
          emitTextDelta(agentMessages.appendCompletedFallback(item));
        } else if (item.type === 'agentReasoning' || item.type === 'reasoning') {
          completeReasoning(itemId || 'reasoning', item);
        } else {
          const event = mapCodexItemToolEvent(item, 'result');
          if (event) opts.onEvent(event);
        }
        return;
      }

      // ── Top-level error ──────────────────────────────────────────
      if (method === 'error') {
        const willRetry = !!params.willRetry;
        const errMsg = (params.error?.message && String(params.error.message))
                    || (typeof params.message === 'string' ? params.message : '');
        if (willRetry) {
          retryAttempt += 1;
          opts.onEvent({
            type: 'status',
            status: 'retrying',
            attempt: retryAttempt,
            ...(errMsg ? { message: errMsg } : {}),
          });
          return;
        }
        turnError = errMsg || 'codex turn failed';
        finishTurn(false);
        return;
      }

      // ── Idle fallback when turn/completed never arrives ─────────
      if (method === 'thread/status/changed') {
        const statusType = params?.status?.type;
        if (statusType === 'idle' && turnStarted) {
          finishTurn(false);
        } else if (statusType === 'systemError') {
          turnError = 'codex thread entered a system error state';
          finishTurn(false);
        } else if (statusType === 'active') {
          const flags = Array.isArray(params?.status?.activeFlags)
            ? params.status.activeFlags
            : [];
          if (flags.includes('waitingOnApproval')) {
            opts.onEvent({ type: 'status', status: 'waiting-approval' });
          } else if (flags.includes('waitingOnUserInput')) {
            opts.onEvent({ type: 'status', status: 'waiting-input' });
          }
        }
        return;
      }

      if (method === 'turn/plan/updated') {
        const plan = Array.isArray(params?.plan) ? params.plan : [];
        opts.onEvent({
          type: 'status',
          status: 'plan-updated',
          steps: plan.map((step: any) => ({
            step: String(step?.step || ''),
            status: String(step?.status || ''),
          })),
          ...(typeof params?.explanation === 'string' && params.explanation
            ? { message: params.explanation }
            : {}),
        });
        return;
      }

      if (method === 'item/mcpToolCall/progress') {
        opts.onEvent({
          type: 'status',
          status: 'tool-progress',
          callId: String(params?.itemId || ''),
          message: String(params?.message || ''),
        });
        return;
      }

      if (method === 'hook/started' || method === 'hook/completed') {
        const run = params?.run || {};
        const name = String(run?.eventName || run?.handlerType || 'hook');
        const completed = method === 'hook/completed';
        const entries = Array.isArray(run?.entries)
          ? run.entries.map((entry: any) => String(entry?.text || '')).filter(Boolean).join('\n')
          : '';
        opts.onEvent({
          type: 'tool-event',
          tool: `hook:${name}`,
          callId: String(run?.id || ''),
          phase: completed ? 'result' : 'use',
          ...(completed
            ? { output: entries || String(run?.statusMessage || run?.status || '') }
            : { input: { status: run?.status || 'running' } }),
        });
        return;
      }

      if (method === 'thread/compacted') {
        opts.onEvent({ type: 'status', status: 'compacted' });
        return;
      }

      if (method === 'model/rerouted') {
        opts.onEvent({
          type: 'status',
          status: 'model-rerouted',
          fromModel: String(params?.fromModel || ''),
          toModel: String(params?.toModel || ''),
          reason: String(params?.reason || ''),
        });
        return;
      }

      if (method === 'warning' || method === 'guardianWarning'
          || method === 'deprecationNotice' || method === 'configWarning') {
        const message = typeof params?.message === 'string'
          ? params.message
          : JSON.stringify(params || {});
        opts.onEvent({ type: 'log', level: 'warn', message, source: 'codex' });
        return;
      }

      if (method === 'thread/closed') {
        if (turnStarted) finishTurn(false);
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
          emitTextDelta(agentMessages.appendDelta({ delta: text }));
          return;
        }
        case 'agent_message_delta': {
          const text = typeof ev.delta === 'string' ? ev.delta
                     : (typeof ev.message === 'string' ? ev.message : '');
          emitTextDelta(agentMessages.appendDelta({ delta: text }));
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
      publishActiveIngress(null);
      if (aborted) turnAborted = true;
      const output = agentMessages.output();
      if (turnAborted) {
        finish('cancelled', { output });
      } else if (turnError) {
        finish('failed', { error: turnError, output, stderrTail: tail.toString() });
      } else {
        finish('completed', { output });
      }
      // Resolve the run from the authoritative protocol terminal event.
      // Process reaping is deliberately asynchronous so an inherited pipe or
      // background terminal cannot leave the conversation spinner running.
      reapCliAfterProtocolTerminal(child);
    }

    function finish(status: 'completed' | 'failed' | 'cancelled' | 'timeout', extra: Record<string, unknown> = {}) {
      if (exited) return;
      publishActiveIngress(null);
      exited = true;
      clearInterval(activityTimer);
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

    function failProtocol(error: string) {
      // A JSON-RPC setup failure resolves before the normal close-driven
      // lifecycle. Explicitly terminate the detached process group so a CLI
      // that keeps its event loop alive cannot outlive the failed dispatch.
      // No turn has started, so a short hard-kill fallback is safer than
      // leaving an uncooperative bootstrap process in the background.
      const hardKill = setTimeout(() => killProcessTree(child, 'SIGKILL'), 250);
      if (typeof hardKill.unref === 'function') hardKill.unref();
      child.once('close', () => clearTimeout(hardKill));
      try { child.stdin.end(); } catch { /* already closed */ }
      killProcessTree(child, 'SIGTERM');
      finish('failed', { error, stderrTail: tail.toString() });
    }

    child.on('error', err => {
      log.warn('codex spawn error', { error: logErrorSummary(err) });
      finish('failed', { error: (err as Error).message, stderrTail: tail.toString() });
    });
    child.on('close', code => {
      const output = agentMessages.output();
      if (opts.signal.aborted) return finish('cancelled', { output });
      if (watchdog.fired()) return finish('timeout', { error: `cli ${watchdog.reason()}`, output, stderrTail: tail.toString() });
      if (turnAborted) return finish('cancelled', { output });
      if (turnError) return finish('failed', { error: turnError, output, stderrTail: tail.toString() });
      if (code === 0 && (turnCompleted || agentMessages.hasText())) {
        return finish('completed', { output });
      }
      finish('failed', {
        error: `codex exited with code ${code}` + (turnCompleted ? '' : ' (turn never completed)'),
        output,
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

        const prepared = await startOrResumeThread(opts);
        threadId = prepared.threadId;
        if (!threadId) {
          failProtocol('codex thread/start returned no thread id');
          return;
        }

        await rpc('turn/start', {
          threadId,
          input: [{
            type: 'text',
            text: selectCodexTurnPrompt(opts, prepared.resumed),
          }],
          ...buildCodexTurnRuntimeOverrides(opts),
          ...buildCodexTurnPermissionOverrides(opts.cwd),
        });
        // After turn/start succeeds we wait passively — turn end is
        // driven by `turn/completed` / `task_complete` notifications.
        // Their protocol terminal immediately resolves outerPromise;
        // process cleanup continues asynchronously.
      } catch (err) {
        const msg = (err as Error).message || String(err);
        log.warn('codex protocol error', { error: logErrorSummary(err) });
        if (!exited) failProtocol(msg);
      }
    })();

    async function startOrResumeThread(
      o: BackendRunOptions,
    ): Promise<{ threadId?: string; resumed: boolean }> {
      if (o.resumeSessionId) {
        try {
          const r = await rpc('thread/resume', {
            threadId: o.resumeSessionId,
            cwd: o.cwd,
            ...buildCodexThreadPermissionOverrides(),
            ...codexThreadDeveloperInstructionParams(o, true),
          });
          const tid = extractThreadId(r);
          if (tid) return { threadId: tid, resumed: true };
          log.warn('codex thread/resume returned no thread id; falling back to thread/start');
        } catch (err) {
          log.warn('codex thread/resume failed; falling back to thread/start', { error: logErrorSummary(err) });
        }
      }
      const r = await rpc('thread/start', {
        modelProvider: null,
        profile: null,
        cwd: o.cwd,
        ...buildCodexThreadPermissionOverrides(),
        config: null,
        baseInstructions: null,
        ...codexThreadDeveloperInstructionParams(o, false),
        compactPrompt: null,
        includeApplyPatchTool: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
      return { threadId: extractThreadId(r), resumed: false };
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
 * this makes the agent reach for it. Orkas durable CLI instructions share
 * this native field; null means neither source supplied content. Exported for
 * tests.
 */
export function codexDeveloperInstructions(opts: BackendRunOptions): string | null {
  const value = [
    opts.systemPrompt,
    opts.bridge?.appendSystemPrompt,
  ].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
  return value || null;
}

/**
 * Codex persists developer instructions in its native thread. Once the stored
 * Orkas hash matches, omit the resume override entirely; `null` would clear it.
 * A resume fallback still calls thread/start and therefore restores the full
 * current instruction bundle.
 */
export function codexThreadDeveloperInstructionParams(
  opts: BackendRunOptions,
  resumed: boolean,
): { developerInstructions?: string | null } {
  if (resumed && opts.reuseSessionInstructions) return {};
  return { developerInstructions: codexDeveloperInstructions(opts) };
}

/**
 * A rejected resume must never run a delta-only turn on the replacement
 * thread. Keep this decision pure so the recovery boundary is deterministic
 * and independently covered without starting Codex.
 */
export function selectCodexTurnPrompt(
  opts: Pick<BackendRunOptions, 'prompt' | 'resumeSessionId' | 'resumeFallbackPrompt'>,
  resumed: boolean,
): string {
  if (resumed || !opts.resumeSessionId) return opts.prompt;
  return opts.resumeFallbackPrompt || opts.prompt;
}

/** Optional per-turn overrides. Omitting keys is significant: Codex then
 * resolves the account/profile default and keeps existing sessions portable. */
export function buildCodexTurnRuntimeOverrides(
  opts: Pick<BackendRunOptions, 'modelOverride' | 'thinkingLevel'>,
): { model?: string; effort?: string } {
  return {
    ...(opts.modelOverride ? { model: opts.modelOverride } : {}),
    ...(opts.thinkingLevel ? { effort: opts.thinkingLevel } : {}),
  };
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
