/** Only a failure before writing proves that a cancellation was not sent. */
export class CliInputNotSentError extends Error {}

/** Missing receipts leave the outcome unknown; never replay an uncertain reply. */
export class CliInputCancellation {
  private confirmed = false;
  private uncertain = false;
  private sentOrUnknown = false;
  private pending?: Promise<'cancelled' | 'closed' | 'failed' | 'unknown'>;
  private finish?: (result: 'cancelled' | 'closed' | 'failed' | 'unknown') => void;

  constructor(private readonly signal: AbortSignal, private readonly send: () => Promise<void>) {}

  get mayHaveSent(): boolean { return this.sentOrUnknown; }

  confirm(): void {
    this.confirmed = true;
    this.finish?.('cancelled');
  }

  cancel = (): Promise<'cancelled' | 'closed' | 'failed' | 'unknown'> => {
    if (this.confirmed) return Promise.resolve('cancelled');
    if (this.signal.aborted) return Promise.resolve('closed');
    if (this.pending) return this.pending;
    if (this.uncertain) return Promise.resolve('unknown');
    const attempt = new Promise<'cancelled' | 'closed' | 'failed' | 'unknown'>(resolve => {
      const finish = (result: 'cancelled' | 'closed' | 'failed' | 'unknown') => {
        if (this.finish !== finish) return;
        this.finish = undefined;
        this.uncertain = result === 'unknown';
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => finish(this.confirmed ? 'cancelled' : 'closed');
      // Bound receipt waiting only. This is neither a question deadline nor
      // evidence that the CLI rejected the cancellation.
      const timer = setTimeout(() => finish('unknown'), 5_000);
      timer.unref?.();
      this.finish = finish;
      this.signal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve().then(() => {
        if (this.signal.aborted) { onAbort(); return; }
        this.sentOrUnknown = true;
        return this.send();
      }).catch(error => {
        if (error instanceof CliInputNotSentError) {
          this.sentOrUnknown = false;
          finish('failed');
        } else {
          finish('unknown');
        }
      });
    });
    this.pending = attempt.finally(() => { this.pending = undefined; });
    return this.pending;
  };
}
