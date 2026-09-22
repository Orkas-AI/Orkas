import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { Semaphore } from 'async-mutex';
import { WS_ROOT } from '../../paths';
import { createLogger } from '../../logger';
import type { ChatSnippet } from './snippet';

const log = createLogger('search');

let worker: Worker | undefined;
let sequence = 0;
let unavailableUntil = 0;
let generation = 0;
const io = new Semaphore(4);
const pending = new Map<number, {
  resolve: (rows: Map<number, ChatSnippet | undefined>) => void;
  reject: (error: Error) => void;
}>();

function rejectPending(): void {
  for (const request of pending.values()) request.reject(new Error('Chat snippet reader unavailable'));
  pending.clear();
}

/** Large JSON parsing and display projection must not monopolize Electron's
 * main loop. Only paths/positions go in and small display snippets come back.
 * A shared IO semaphore bounds this worker's in-flight queue. */
export function readChatSnippets(file: string, indexes: ReadonlySet<number>, tokens: readonly string[]): Promise<Map<number, ChatSnippet | undefined>> {
  const expectedGeneration = generation;
  return io.runExclusive(() => {
    if (generation !== expectedGeneration) throw new Error('Chat snippet reader closed');
    return requestSnippets(file, indexes, tokens);
  });
}

function requestSnippets(file: string, indexes: ReadonlySet<number>, tokens: readonly string[]): Promise<Map<number, ChatSnippet | undefined>> {
  if (Date.now() < unavailableUntil) return Promise.reject(new Error('Chat snippet reader unavailable'));
  if (!worker) {
    const current = new Worker(path.join(__dirname, 'chat-snippet-entry.js'), {
      execArgv: [], env: { ...process.env, ORKAS_WORKSPACE_ROOT: WS_ROOT },
    });
    worker = current;
    current.on('message', (message) => {
      if (worker !== current) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      request?.resolve(new Map(message.rows));
      if (!pending.size) current.unref();
    });
    const fail = () => {
      if (worker !== current) return;
      worker = undefined;
      unavailableUntil = Date.now() + 30_000;
      log.warn('chat snippet worker stopped; retry deferred');
      rejectPending();
      void current.terminate();
    };
    current.on('error', fail);
    current.on('exit', fail);
  }
  const current = worker;
  const id = ++sequence;
  current.ref();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { current.postMessage({ id, file, indexes: [...indexes], tokens }); }
    catch {
      pending.delete(id);
      if (!pending.size) current.unref();
      reject(new Error('Chat snippet reader unavailable'));
    }
  });
}

export async function closeChatSnippetReader(): Promise<void> {
  generation++;
  const current = worker;
  worker = undefined;
  unavailableUntil = 0;
  rejectPending();
  await current?.terminate();
}
