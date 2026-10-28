/** Preserve the existing extractors while moving OOXML CPU work off main.
 * Admission limits simultaneous work, never supported input or queue length. */
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { isZipSpreadsheet, xlsBufferToMarkdown } from './extract-xls';

export type OfficeExtraction = 'xlsx-markdown' | 'xlsx-html' | 'pptx-markdown' | 'pptx-html' | 'spreadsheet-markdown';
type Input = Buffer | ((signal: AbortSignal) => Promise<Buffer>);
type Job = { kind: OfficeExtraction; input: Input; resolve(value: string): void; reject(error: Error): void };
const queue: Job[] = [];
const active = new Set<{ cancel(): Promise<void> }>();
const idle: Worker[] = [];
let closing: Promise<void> | undefined;

export function extractOffice(kind: OfficeExtraction, input: Input): Promise<string> {
  if (closing) return Promise.reject(new Error('Office extraction closed'));
  return new Promise((resolve, reject) => { queue.push({ kind, input, resolve, reject }); pump(); });
}

function pump(): void {
  while (!closing && active.size < 2 && queue.length) {
    const job = queue.shift()!;
    const controller = new AbortController();
    let worker: Worker | undefined = idle.pop(), settled = false;
    let completion: Promise<void> | undefined;
    const finish = (error?: Error, text?: string): Promise<void> => {
      if (completion) return completion;
      settled = true;
      const reuse = !error && worker && queue.length && !closing;
      if (reuse) {
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        worker.removeAllListeners('exit');
        idle.push(worker);
      }
      completion = Promise.resolve(reuse ? undefined : worker?.terminate()).then(() => {}, () => {}).then(() => {
        active.delete(owner);
        if (error) job.reject(error); else job.resolve(text!);
        pump();
      });
      return completion;
    };
    const owner = { cancel: () => {
      controller.abort();
      return finish(new Error('Office extraction closed'));
    } };
    active.add(owner);
    let listening = false;
    const listen = () => {
      if (listening) return;
      listening = true;
      worker!.once('message', message => {
        if (message.ok && typeof message.text === 'string') void finish(undefined, message.text);
        else void finish(new Error(String(message.error || 'Office extraction failed')));
      });
      worker!.once('error', () => { void finish(new Error('Office extraction failed')); });
      worker!.once('exit', () => { if (!settled) void finish(new Error('Office extraction failed')); });
    };
    // A reused worker is already alive while its next lazy input is loading.
    if (worker) listen();
    void (async () => {
      // Lazy inputs are read only after admission, so a burst does not read
      // every file into memory while waiting for a parser slot.
      const input = typeof job.input === 'function' ? await job.input(controller.signal) : job.input;
      if (settled) return;
      if (job.kind === 'spreadsheet-markdown' && !isZipSpreadsheet(input)) {
        // Keep the existing process-wide legacy XLS pool and its contract.
        const text = await xlsBufferToMarkdown(input);
        if (!settled) await finish(undefined, text);
        return;
      }
      worker ||= new Worker(path.join(__dirname, 'office-extract-entry.js'), { execArgv: [] });
      listen();
      // Transfer an owned copy; caller buffers and caches must stay attached.
      const bytes = new Uint8Array(input);
      worker.postMessage({ kind: job.kind === 'spreadsheet-markdown' ? 'xlsx-markdown' : job.kind, bytes }, [bytes.buffer]);
    })().catch(error => { if (!settled) void finish(error instanceof Error ? error : new Error('Office extraction failed')); });
  }
}

export function closeOfficeExtraction(): Promise<void> {
  if (closing) return closing;
  const error = new Error('Office extraction closed');
  for (const job of queue.splice(0)) job.reject(error);
  // Set the barrier before cancellation can synchronously call any consumer.
  closing = Promise.resolve().then(async () => {
    await Promise.all([...active].map(owner => owner.cancel()));
    await Promise.all(idle.splice(0).map(worker => worker.terminate()));
  })
    .finally(() => { closing = undefined; });
  return closing;
}
