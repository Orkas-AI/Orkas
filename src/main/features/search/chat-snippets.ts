import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { Semaphore } from 'async-mutex';
import { WS_ROOT } from '../../paths';
import { createLogger } from '../../logger';
import type { ChatSnippet } from './snippet';

const log = createLogger('search');
interface Reader {
  worker?: Worker;
  unavailableUntil: number;
  pending: Map<number, {
    resolve: (rows: Map<number, ChatSnippet | undefined>) => void;
    reject: (error: Error) => void;
  }>;
}
const readers: Reader[] = Array.from({ length: 2 }, () => ({ unavailableUntil: 0, pending: new Map() }));
// Stable source affinity reuses each worker's bounded projection/offset cache.
// Two workers cap simultaneous large-record parsing; four in-flight requests
// bound dispatch overhead without opening one worker per matching history.
const affinity = new Map<string, Reader>();
const io = new Semaphore(4);
let sequence = 0;
let generation = 0;

function rejectPending(reader: Reader): void {
  for (const request of reader.pending.values()) request.reject(new Error('Chat snippet reader unavailable'));
  reader.pending.clear();
}

export function readChatSnippets(file: string, indexes: ReadonlySet<number>, tokens: readonly string[], signal?: AbortSignal, source?: { userId: string; cid: string }): Promise<Map<number, ChatSnippet | undefined>> {
  const expectedGeneration = generation;
  return io.runExclusive(() => {
    if (generation !== expectedGeneration) throw new Error('Chat snippet reader closed');
    if (signal?.aborted) return new Map();
    let reader = affinity.get(file);
    if (!reader) {
      const available = readers.filter(candidate => candidate.unavailableUntil <= Date.now());
      reader = (available.length ? available : readers)
        .reduce((best, candidate) => candidate.pending.size < best.pending.size ? candidate : best);
      if (affinity.size >= 512) affinity.delete(affinity.keys().next().value!);
      affinity.set(file, reader);
    }
    return requestSnippets(reader, file, indexes, tokens, signal, source);
  });
}

function requestSnippets(reader: Reader, file: string, indexes: ReadonlySet<number>, tokens: readonly string[], signal?: AbortSignal, source?: { userId: string; cid: string }): Promise<Map<number, ChatSnippet | undefined>> {
  if (Date.now() < reader.unavailableUntil) return Promise.reject(new Error('Chat snippet reader unavailable'));
  if (!reader.worker) {
    const current = new Worker(path.join(__dirname, 'chat-snippet-entry.js'), {
      execArgv: [], env: { ...process.env, ORKAS_WORKSPACE_ROOT: WS_ROOT },
    });
    reader.worker = current;
    current.on('message', (message) => {
      if (reader.worker !== current) return;
      const request = reader.pending.get(message.id);
      reader.pending.delete(message.id);
      request?.resolve(new Map(message.rows));
      if (!reader.pending.size) current.unref();
    });
    const fail = () => {
      if (reader.worker !== current) return;
      reader.worker = undefined;
      reader.unavailableUntil = Date.now() + 30_000;
      log.warn('chat snippet worker stopped; retry deferred');
      rejectPending(reader);
      void current.terminate();
    };
    current.on('error', fail);
    current.on('exit', fail);
  }
  const current = reader.worker;
  const id = ++sequence;
  current.ref();
  return new Promise((resolve, reject) => {
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const cleanup = () => signal?.removeEventListener('abort', cancel);
    const cancel = () => {
      Atomics.store(cancellation, 0, 1);
      reader.pending.delete(id);
      cleanup();
      resolve(new Map());
      // Parsing one oversized JSON record cannot yield. Stop an unused worker
      // immediately, but keep unrelated requests alive on a shared reader.
      if (!reader.pending.size && reader.worker === current) {
        reader.worker = undefined;
        void current.terminate();
      }
    };
    reader.pending.set(id, {
      resolve: rows => { cleanup(); resolve(rows); },
      reject: error => { cleanup(); reject(error); },
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    try { current.postMessage({ id, file, indexes: [...indexes], tokens, source, cancellation: cancellation.buffer }); }
    catch {
      cleanup();
      reader.pending.delete(id);
      if (!reader.pending.size) current.unref();
      reject(new Error('Chat snippet reader unavailable'));
    }
  });
}

export async function closeChatSnippetReader(): Promise<void> {
  generation++;
  affinity.clear();
  await Promise.all(readers.map(async reader => {
    const current = reader.worker;
    reader.worker = undefined;
    reader.unavailableUntil = 0;
    rejectPending(reader);
    await current?.terminate();
  }));
}
