import type { ChildProcess } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';
import { killProcessTree } from '../../../src/core-agent/src/sandbox/executor';

type OwnedApplication = {
  process(): ChildProcess;
  close(): Promise<void>;
  context(): { tracing: { stop(options: { path: string }): Promise<void> } };
};

/** Run quit on the normal event loop, outside the inspector evaluation stack.
 * Keep Electron's before-quit flushes and wait for the actual application close. */
export async function requestElectronQuit(app: ElectronApplication): Promise<void> {
  // Closing the final window already starts normal shutdown on Windows/Linux.
  // The inspector may disconnect before a second app.quit() can be evaluated.
  if (process.platform !== 'darwin' && app.windows().length === 0) {
    const child = app.process();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    return;
  }
  let closed = false;
  let complete!: () => void;
  const completion = new Promise<void>(resolve => { complete = resolve; });
  const onClose = () => { closed = true; complete(); };
  app.once('close', onClose);
  try {
    try {
      await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    } catch (error) {
      // A fast successful exit may dispose the inspector before it replies.
      // Playwright can report this before delivering the application close event.
      // Still require that event below; the fixture's close deadline stays active.
      const inspectorDisposed = error instanceof Error && error.message ===
        'electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.';
      if (!closed && !inspectorDisposed) throw error;
    }
    await completion;
  } finally {
    app.off('close', onClose);
  }
}

/** A failed shutdown must fail the case, release its owned process and leave
 * phase evidence, rather than hanging the entire Playwright worker. */
export async function closeElectronFixture(app: OwnedApplication, tracePath: string, options: {
  phase?: (name: string, outcome: string) => void;
  traceTimeoutMs?: number;
  closeTimeoutMs?: number;
} = {}): Promise<void> {
  // Playwright disposes the application object on close; retain ownership first.
  const child = app.process();
  const failures: string[] = [];
  const causes: unknown[] = [];
  const step = async (name: string, timeoutMs: number, action: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    options.phase?.(name, 'started');
    try {
      await Promise.race([action(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), timeoutMs);
      })]);
      options.phase?.(name, 'completed');
    } catch (error) {
      failures.push(name);
      causes.push(error);
      options.phase?.(name, 'failed');
    } finally { clearTimeout(timer); }
  };
  await step('trace-stop', options.traceTimeoutMs ?? 5_000, () => app.context().tracing.stop({ path: tracePath }));
  await step('application-close', options.closeTimeoutMs ?? 20_000, () => app.close());
  if (child.exitCode === null && child.signalCode === null) {
    await step('owned-process-cleanup', 6_000, () => new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      killProcessTree(child, 'SIGKILL', { onComplete: () => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
      } });
      child.once('error', reject);
    }));
  }
  if (failures.length) throw new Error(`Electron fixture cleanup failed: ${failures.join(', ')}`, { cause: causes[0] });
}
