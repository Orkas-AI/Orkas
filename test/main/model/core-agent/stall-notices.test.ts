import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// W2-1 (conv-review-20260811): sampled conversations showed hangs surfacing
// to the user only after 18-42 minutes, when the idle watchdog or a provider
// error finally fired. `withStallNotices` is the host-side fix: a silent
// mapped-event stream gains user-visible "still waiting, Stop is available"
// progress rows at 60s (model/provider wait) or 300s (tool execution), long
// before either timeout tier. These cases pin the contract: notices appear on
// schedule, never reorder or swallow real events, never fire while events
// flow, and are tagged `stream:'stall_notice'` so the pump loop and the
// task-turn sampler can tell them from real model activity.

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  dialog: {},
  shell: {},
}));

type AnyEvent = {
  type: string;
  text?: string;
  event?: { stream?: string; data?: Record<string, unknown> };
};

function deferredStream(): {
  stream: AsyncIterable<AnyEvent>;
  push: (ev: AnyEvent) => void;
  end: () => void;
} {
  const queue: AnyEvent[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  return {
    push: (ev) => { queue.push(ev); notify?.(); },
    end: () => { ended = true; notify?.(); },
    stream: {
      async* [Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) { yield queue.shift()!; continue; }
          if (ended) return;
          await new Promise<void>((resolve) => { notify = resolve; });
          notify = null;
        }
      },
    },
  };
}

describe('withStallNotices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function collectWhile(
    iterator: AsyncGenerator<AnyEvent, void, unknown>,
    out: AnyEvent[],
    steps: Array<() => Promise<void> | void>,
  ): Promise<void> {
    const pump = (async () => {
      for await (const ev of iterator) out.push(ev);
    })();
    for (const step of steps) {
      await step();
      // Let the pump observe whatever the step made available.
      await vi.advanceTimersByTimeAsync(0);
    }
    await pump;
  }

  it('surfaces a model-wait stall at 60s and repeats every 120s until events resume', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const { stream, push, end } = deferredStream();
    const out: AnyEvent[] = [];
    await collectWhile(
      client.withStallNotices(stream as never, { inToolPhase: () => false }) as never,
      out,
      [
        // Silent for 61s → first notice.
        () => vi.advanceTimersByTimeAsync(61_000),
        () => {
          expect(out).toHaveLength(1);
          expect(out[0]).toMatchObject({
            type: 'progress',
            event: { stream: 'stall_notice', data: { phase: 'provider_wait' } },
          });
          expect(String(out[0].text || '')).toBeTruthy();
        },
        // Still silent through 60+120s → second notice, with grown elapsed.
        () => vi.advanceTimersByTimeAsync(120_000),
        () => {
          expect(out).toHaveLength(2);
          expect(Number(out[1].event?.data?.elapsed_s)).toBeGreaterThanOrEqual(180);
        },
        // A real event ends the silence and passes through unchanged.
        () => { push({ type: 'delta', text: 'model woke up' }); },
        () => {
          expect(out).toHaveLength(3);
          expect(out[2]).toMatchObject({ type: 'delta', text: 'model woke up' });
        },
        // The silence clock restarted: 59s later there is no new notice.
        () => vi.advanceTimersByTimeAsync(59_000),
        () => { expect(out).toHaveLength(3); },
        () => { end(); },
      ],
    );
    expect(out).toHaveLength(3);
  });

  it('waits 300s before the first notice while a tool is executing', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const { stream, end } = deferredStream();
    const out: AnyEvent[] = [];
    await collectWhile(
      client.withStallNotices(stream as never, { inToolPhase: () => true }) as never,
      out,
      [
        () => vi.advanceTimersByTimeAsync(299_000),
        () => { expect(out).toHaveLength(0); },
        () => vi.advanceTimersByTimeAsync(2_000),
        () => {
          expect(out).toHaveLength(1);
          expect(out[0]).toMatchObject({
            type: 'progress',
            event: { stream: 'stall_notice', data: { phase: 'tool' } },
          });
        },
        () => { end(); },
      ],
    );
  });

  it('emits nothing for a stream that keeps producing events', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const { stream, push, end } = deferredStream();
    const out: AnyEvent[] = [];
    await collectWhile(
      client.withStallNotices(stream as never, { inToolPhase: () => false }) as never,
      out,
      [
        ...Array.from({ length: 5 }, (_ignored, index) => [
          () => { push({ type: 'delta', text: `chunk-${index}` }); },
          () => vi.advanceTimersByTimeAsync(50_000),
        ]).flat(),
        () => { end(); },
      ],
    );
    expect(out.map((ev) => ev.type)).toEqual(['delta', 'delta', 'delta', 'delta', 'delta']);
    expect(out.some((ev) => ev.event?.stream === 'stall_notice')).toBe(false);
  });
});
