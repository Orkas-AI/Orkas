/**
 * Normalize the core-agent terminal run receipt into the same persisted
 * runtime event used by the main conversation. Agent/skill edit chats stream
 * core-agent events directly, so they do not pass through group_chat/bus.ts's
 * runtimeProcessItem adapter.
 */

function finiteDuration(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function runtimeDataFromAgentRunResult(data: Record<string, unknown>): Record<string, unknown> {
  const result = String(data.result || '');
  const terminalStatus = String(data.terminal_status || data.status || '');
  const aborted = result === 'aborted' || terminalStatus === 'aborted';
  const errored = !aborted && result !== 'success' && terminalStatus !== 'completed';
  const durationMs = finiteDuration(data.duration_ms);

  return {
    ...data,
    phase: 'end',
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    status: errored || aborted ? 'error' : 'success',
    aborted,
    errored,
  };
}

export function normalizeEditChatRuntimeEvent(event: any): any {
  if (event?.type !== 'event' || event?.event?.stream !== 'agent_run_result') return event;
  const data = event.event.data && typeof event.event.data === 'object'
    ? event.event.data as Record<string, unknown>
    : {};
  return {
    ...event,
    event: {
      ...event.event,
      stream: 'runtime',
      data: runtimeDataFromAgentRunResult(data),
    },
  };
}

export function ensureEditChatRuntimeProcessItem(
  processItems: any[],
  startedAtMs: number,
  outcome: { aborted?: boolean; errored?: boolean } = {},
): void {
  if (processItems.some((item) => (
    item?.type === 'event'
    && item?.event?.stream === 'runtime'
    && finiteDuration(item?.event?.data?.duration_ms) !== undefined
  ))) return;

  const aborted = outcome.aborted === true;
  const errored = outcome.errored === true;
  processItems.push({
    type: 'event',
    event: {
      stream: 'runtime',
      data: {
        phase: 'end',
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        status: aborted || errored ? 'error' : 'success',
        aborted,
        errored,
      },
    },
  });
}
