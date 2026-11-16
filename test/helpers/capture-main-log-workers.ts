import { expect, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { Writable, type Readable } from 'node:stream';

/** Track the real workers after resetModules so workspace teardown cannot race
 * queued log writes. Wait for delivery before termination to retain evidence. */
export async function captureMainLogWorkers(): Promise<() => Promise<void>> {
  type DeliveryModule = typeof import('../../src/main/util/log-delivery');
  const deliveries: ReturnType<DeliveryModule['createLogDelivery']>[] = [];
  const consoles: Array<{ source: Readable; forward: Writable }> = [];
  const consoleErrors: Error[] = [];
  const previousDisable = process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY;
  process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY = '0';
  // A persistent module mock, rather than a spy on one module instance, also
  // captures workers created after a case calls resetModules() again.
  vi.doMock('../../src/main/util/log-delivery', async importOriginal => {
    const module = await importOriginal<DeliveryModule>();
    return {
      ...module,
      createLogDelivery: (...args: Parameters<DeliveryModule['createLogDelivery']>) => {
        const factory = args[1] || ((file, config) => new Worker(file, config));
        const delivery = module.createLogDelivery(args[0], (file, config) => {
          // Explicit streams let cleanup observe EOF. The worker's delivery
          // acknowledgement/exit can arrive before its default console mirror.
          const worker = factory(file, { ...config, stdout: true, stderr: true });
          for (const stream of ['stdout', 'stderr'] as const) {
            if (!worker[stream]) throw new Error('Log worker console capture is unavailable');
            const output = worker[stream]!;
            // Retain the same intercepted parent destination as ordinary pipe.
            const target = process[stream];
            const write = target.write.bind(target);
            // Each pipe owns its destination listeners. Forward writes through
            // their callbacks rather than piping every restart worker directly
            // into the shared process stream. Keep ordinary stream backpressure.
            const forward = new Writable({
              // Writable supplies Buffer chunks with internal encoding "buffer".
              // Omit that sentinel, as pipe does, so the parent's text tap can
              // decode the original bytes while the callback still owns drain.
              write(chunk, _encoding, done) { write(chunk, done); },
            });
            forward.on('error', error => { consoleErrors.push(error); });
            consoles.push({ source: output, forward });
            output.pipe(forward);
          }
          return worker;
        });
        deliveries.push(delivery);
        return delivery;
      },
    };
  });
  return async () => {
    try {
      for (const delivery of deliveries) {
        await vi.waitFor(() => expect(delivery.stats().pending).toBe(0));
        expect(delivery.stats()).toMatchObject({ dropped: 0, failed: false });
      }
    } finally {
      try {
        const closed = await Promise.allSettled(deliveries.map(delivery => delivery.close()));
        let consoleFailure: unknown;
        try {
          await vi.waitFor(() => {
            for (const { source, forward } of consoles) {
              expect(source.readableEnded).toBe(true);
              expect(forward.writableFinished).toBe(true);
            }
          }, { timeout: 2_000, interval: 10 });
        } catch (error) { consoleFailure = error; }
        const failed = closed.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (consoleErrors.length) throw consoleErrors[0];
        if (consoleFailure) throw consoleFailure;
      }
      finally {
        for (const { source, forward } of consoles) {
          source.unpipe(forward);
          forward.destroy();
        }
        vi.doUnmock('../../src/main/util/log-delivery');
        if (previousDisable === undefined) delete process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY;
        else process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY = previousDisable;
      }
    }
  };
}
