export interface ShutdownTask {
  name: string;
  run: () => void | Promise<void>;
}

export interface ShutdownProcesses {
  terminate(): Promise<void>;
  dispose(): void;
}

/** Archive active work before closing dependencies and owned processes. */
export function createShutdownCoordinator({ captureProcesses, quiesce, localTasks, onFailure, onIncomplete }: {
  captureProcesses?: () => Promise<ShutdownProcesses>;
  quiesce?: () => Promise<void>;
  localTasks: readonly ShutdownTask[];
  onFailure: (name: string) => void;
  onIncomplete?: () => void | Promise<void>;
}) {
  let pending: Promise<void> | null = null;
  let complete = false;
  let quiescent = false;
  const run = async (task: ShutdownTask) => {
    try { await task.run(); }
    catch { onFailure(task.name); }
  };
  return {
    get complete() { return complete; },
    get quiescent() { return quiescent; },
    prepare(mode: 'quit' | 'relaunch' = 'quit'): Promise<void> {
      if (pending) return pending;
      // Publish the shared promise before any cleanup can synchronously emit
      // another quit (for example while Electron loads a native module).
      quiescent = false;
      pending = Promise.resolve().then(async () => {
        let processes: ShutdownProcesses | undefined;
        try {
          // Pin descendants while their parents still exist. Development's
          // detached replacement launcher belongs to the next app lifetime.
          if (mode !== 'relaunch' && captureProcesses) {
            try { processes = await captureProcesses(); }
            catch (cause) {
              throw Object.assign(new Error('Process shutdown preparation failed', { cause }), {
                code: 'E_SHUTDOWN_PROCESSES_FAILED',
              });
            }
          }
          // Active tasks still own these dependencies. Failure to archive is
          // critical: leave the app open so the same quit can be retried.
          try { if (quiesce) await quiesce(); }
          catch (cause) {
            throw Object.assign(new Error('Active task archival failed', { cause }), {
              code: 'E_SHUTDOWN_ARCHIVE_FAILED',
            });
          }
          quiescent = true;
          // Start every local save/close even if another one is slow or fails.
          await Promise.all(localTasks.map(run));
          try { await processes?.terminate(); }
          catch (cause) {
            throw Object.assign(new Error('Owned processes could not be stopped', { cause }), {
              code: 'E_SHUTDOWN_PROCESSES_FAILED',
            });
          }
          complete = true;
        } finally { processes?.dispose(); }
      }).catch(async (error) => {
        quiescent = false;
        // A failed exit leaves the application open. Re-admit new work only
        // after this attempt has finished disposing its old dependencies.
        try { await onIncomplete?.(); }
        catch { onFailure('resume'); }
        pending = null;
        throw error;
      });
      return pending;
    },
  };
}
