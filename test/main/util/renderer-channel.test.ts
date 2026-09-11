import { describe, expect, it, vi } from 'vitest';

import { createRendererChannel } from '../../../src/main/util/renderer-channel';

function harness(overrides: { ready?: boolean; user?: string | null; accept?: boolean } = {}) {
  const state = {
    ready: overrides.ready ?? true,
    user: overrides.user === undefined ? 'u1' : overrides.user,
    accept: overrides.accept ?? true,
  };
  const broadcast = vi.fn((_channel: string, _payload: unknown) => state.accept);
  const deps = {
    broadcast,
    rendererReady: () => state.ready,
    activeUserId: () => state.user,
  };
  return { state, broadcast, deps };
}

describe('renderer channel', () => {
  it('delivers an owner-scoped row for the active account and drops one for any other', () => {
    const { broadcast, deps } = harness();
    const channel = createRendererChannel('telemetry:x', { maxPending: 10, ownerScoped: true }, deps);

    channel.emit({ n: 1 }, 'u1');
    channel.emit({ n: 2 }, 'u2');
    channel.emit({ n: 3 });

    expect(broadcast.mock.calls.map((call) => call[1])).toEqual([{ n: 1 }]);
    expect(channel.pending()).toBe(0);
  });

  it('buffers while the renderer is loading and replays to the same account on flush', () => {
    const { state, broadcast, deps } = harness({ ready: false });
    const channel = createRendererChannel('telemetry:x', { maxPending: 10, ownerScoped: true }, deps);

    channel.emit({ n: 1 }, 'u1');
    channel.emit({ n: 2 }, 'u1');
    expect(broadcast).not.toHaveBeenCalled();
    expect(channel.pending()).toBe(2);

    state.ready = true;
    channel.flush();
    expect(broadcast.mock.calls.map((call) => call[1])).toEqual([{ n: 1 }, { n: 2 }]);
    expect(channel.pending()).toBe(0);
  });

  it('drops buffered rows whose owner is no longer the active account', () => {
    // The row was owned by u1 at emission; the account switched before the
    // renderer came back. A terminal of the previous account must never be
    // attached to the new one.
    const { state, broadcast, deps } = harness({ ready: false });
    const channel = createRendererChannel('telemetry:x', { maxPending: 10, ownerScoped: true }, deps);
    channel.emit({ n: 1 }, 'u1');
    state.user = 'u2';
    state.ready = true;

    channel.flush();

    expect(broadcast).not.toHaveBeenCalled();
    expect(channel.pending()).toBe(0);

    state.user = null;
    channel.emit({ n: 2 }, 'u2');
    expect(channel.pending()).toBe(0);
  });

  it('keeps only the newest maxPending rows and stops replaying when the renderer refuses', () => {
    const { state, broadcast, deps } = harness({ ready: false });
    const channel = createRendererChannel('telemetry:x', { maxPending: 2, ownerScoped: true }, deps);
    channel.emit({ n: 1 }, 'u1');
    channel.emit({ n: 2 }, 'u1');
    channel.emit({ n: 3 }, 'u1');
    expect(channel.pending()).toBe(2);

    state.ready = true;
    state.accept = false;
    channel.flush();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(channel.pending()).toBe(2);

    state.accept = true;
    channel.flush();
    expect(broadcast.mock.calls.map((call) => call[1])).toEqual([{ n: 2 }, { n: 2 }, { n: 3 }]);
  });

  it('lets a global channel choose whether renderer readiness gates delivery', () => {
    const { broadcast, deps } = harness({ ready: false, user: null });
    const immediate = createRendererChannel('auth:x', { maxPending: 5 }, deps);
    const gated = createRendererChannel('telemetry:y', { maxPending: 5, requireRendererReady: true }, deps);

    immediate.emit({ n: 1 });
    gated.emit({ n: 2 });

    expect(broadcast.mock.calls.map((call) => call[0])).toEqual(['auth:x']);
    expect(gated.pending()).toBe(1);
    // No active account is not a reason to hold global rows back; the
    // renderer still is.
    gated.flush();
    expect(broadcast.mock.calls.map((call) => call[0])).toEqual(['auth:x', 'telemetry:y']);
  });
});
