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
    status: errored || aborted ? 'error' : terminalStatus === 'waiting_input' ? 'waiting_input' : 'success',
    aborted,
    errored,
  };
}

export function isEditChatWaitingForInputEvent(event: any): boolean {
  return event?.type === 'event'
    && event.event?.stream === 'runtime'
    && event.event.data?.phase === 'end'
    && event.event.data?.status === 'waiting_input'
    && event.event.data?.result === 'success';
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

/** Keep model commentary on the same chronological process timeline used by
 * main chat. Only adjacent token chunks are coalesced: a tool/progress event
 * between chunks remains a real boundary after history reload. */
export function appendEditChatCommentaryProcessItem(
  processItems: any[],
  text: string,
  maxItems: number,
): boolean {
  const chunk = String(text || '');
  if (!chunk) return false;
  const last = processItems[processItems.length - 1];
  if (last?.type === 'progress'
      && last?.event?.stream === 'assistant'
      && last?.event?.data?.phase === 'commentary') {
    last.text = String(last.text || '') + chunk;
    return true;
  }
  if (processItems.length >= maxItems) return false;
  processItems.push({
    type: 'progress',
    text: chunk,
    event: { stream: 'assistant', data: { phase: 'commentary' } },
  });
  return true;
}

/** Scrub authoring protocol from persisted commentary without changing the
 * live event sequence. The renderer performs the equivalent streaming scrub;
 * this boundary makes restored edit chats obey the same visibility contract. */
export function sanitizeEditChatCommentaryProcessItems(
  processItems: any[],
  sanitize: (text: string) => string,
): any[] {
  const cleaned: any[] = [];
  for (const item of processItems) {
    const commentary = item?.type === 'progress'
      && item?.event?.stream === 'assistant'
      && item?.event?.data?.phase === 'commentary';
    if (!commentary) {
      cleaned.push(item);
      continue;
    }
    const text = sanitize(String(item.text || '')).trim();
    if (text) cleaned.push({ ...item, text });
  }
  return cleaned;
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
