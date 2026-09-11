import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliInputCancellation, CliInputNotSentError } from '../../../../src/main/features/local_agents/cli_input_cancel';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('native question cancellation receipts', () => {
  it('does not confuse a successful write with a receipt, and joins concurrent attempts', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const cancellation = new CliInputCancellation(new AbortController().signal, send);
    const first = cancellation.cancel();
    expect(cancellation.cancel()).toBe(first);
    let finished = false;
    void first.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(false);
    cancellation.confirm();
    expect(await first).toBe('cancelled');
    expect(await cancellation.cancel()).toBe('cancelled');
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries only a proven unsent reply and never replays a missing receipt', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {}).mockRejectedValueOnce(new CliInputNotSentError('not written'));
    const cancellation = new CliInputCancellation(new AbortController().signal, send);
    expect(await cancellation.cancel()).toBe('failed');
    const timedOut = cancellation.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await timedOut).toBe('unknown');
    expect(await cancellation.cancel()).toBe('unknown');
    expect(cancellation.mayHaveSent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    cancellation.confirm();
    expect(await cancellation.cancel()).toBe('cancelled');
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not interpret a transport exception as proof that the CLI rejected the reply', async () => {
    const send = vi.fn(async () => { throw new Error('delivery unknown'); });
    const cancellation = new CliInputCancellation(new AbortController().signal, send);
    expect(await cancellation.cancel()).toBe('unknown');
    expect(await cancellation.cancel()).toBe('unknown');
    expect(send).toHaveBeenCalledOnce();
    expect(cancellation.mayHaveSent).toBe(true);
  });

  it.each(['resolve', 'reject'])('never resends a write that completes after its receipt timeout: %s', async outcome => {
    vi.useFakeTimers();
    let resolveWrite!: () => void;
    let rejectWrite!: (error: Error) => void;
    const send = vi.fn(() => new Promise<void>((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; }));
    const controller = new AbortController();
    const cancellation = new CliInputCancellation(controller.signal, send);
    const result = cancellation.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe('unknown');
    if (outcome === 'resolve') resolveWrite();
    else rejectWrite(new Error('late transport failure'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await cancellation.cancel()).toBe('unknown');
    expect(send).toHaveBeenCalledOnce();
    controller.abort();
    expect(await cancellation.cancel()).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats native withdrawal as closed and never sends after withdrawal', async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {});
    const cancellation = new CliInputCancellation(controller.signal, send);
    const result = cancellation.cancel();
    controller.abort();
    expect(await result).toBe('closed');
    expect(await cancellation.cancel()).toBe('closed');
    expect(send).not.toHaveBeenCalled();
  });
});
