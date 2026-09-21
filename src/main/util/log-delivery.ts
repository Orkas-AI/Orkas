import { Worker } from 'node:worker_threads';
import * as path from 'node:path';

/** A bounded, best-effort mailbox. Saturation must never wait for a disk write. */
export function createLogDelivery(options: Record<string, unknown>, makeWorker = (file: string, config: any) => new Worker(file, config)) {
  let pending = 0;
  let dropped = 0;
  let failed = false;
  let unreportedDrops = 0;
  function noteDrop() { dropped += 1; unreportedDrops += 1; }
  const worker = makeWorker(path.join(__dirname, '..', 'logger-worker.js'), { workerData: options });
  worker.on('error', () => { failed = true; pending = 0; });
  worker.on('exit', () => { failed = true; pending = 0; });
  worker.on('message', (ack) => {
    pending = Math.max(0, pending - 1);
    if (ack?.written === false) { noteDrop(); return; }
    if (unreportedDrops && !failed && pending < 256) {
      const count = unreportedDrops;
      unreportedDrops = 0;
      try {
        worker.postMessage({ level: 'warn', scope: 'logger', date: new Date(),
          data: ['Log records dropped', { dropped: count }] });
        pending += 1;
      } catch (_) { unreportedDrops += count; }
    }
  });
  worker.unref();
  return {
    noteDrop,
    canAccept(level: string) { return !failed && pending < (level === 'error' || level === 'warn' ? 256 : 192); },
    send(message: { level: string; [key: string]: unknown }) {
      if (!this.canAccept(message.level)) { noteDrop(); return; }
      try { worker.postMessage(message); pending += 1; }
      catch (_) { noteDrop(); }
    },
    stats() { return { pending, dropped, failed }; },
    async close() { failed = true; pending = 0; await worker.terminate(); },
  };
}
