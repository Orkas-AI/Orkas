import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { WS_ROOT } from '../paths';

export type HistoryCommand = {
  kind: 'page' | 'window' | 'project' | 'purge' | 'turns' | 'turn-purge';
  userId: string;
  sourceFile: string;
  cid?: string;
  projectIdHint?: string | null;
  limit?: number;
  before?: number | null;
  after?: number;
  start?: number;
  records?: import('./group_chat/visibility').GroupMessage[];
};

/** One serialized worker bounds simultaneous raw history allocations. Only
 * projected rows cross back to main; idle workers release their heap. */
export class ConversationHistoryWorker {
  private worker: Worker;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private idle?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private stopped = false;
  private closing?: Promise<void>;

  get available(): boolean { return !this.stopped; }

  constructor() {
    this.worker = new Worker(path.join(__dirname, 'conversation-history-entry.js'), {
      execArgv: [], env: { ...process.env, ORKAS_WORKSPACE_ROOT: WS_ROOT },
    });
    this.worker.on('message', (message) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error('Conversation history operation failed'));
      this.armDeadline();
      if (!this.pending.size) {
        this.worker.unref();
        this.idle = setTimeout(() => { void this.close(); }, 30_000);
        this.idle.unref();
      }
    });
    // Never forward parser/loader errors containing private paths or records.
    this.worker.on('error', () => { void this.close(); });
    this.worker.on('exit', () => { void this.close(); });
  }

  private armDeadline(): void {
    clearTimeout(this.deadline);
    if (this.pending.size) {
      this.deadline = setTimeout(() => { void this.close(); }, 120_000);
      this.deadline.unref();
    }
  }

  request<T>(command: HistoryCommand): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Conversation history worker stopped'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Conversation history worker busy'));
    clearTimeout(this.idle);
    this.worker.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.pending.size === 1) this.armDeadline();
      try { this.worker.postMessage({ id, ...command }); }
      catch { void this.close(); }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearTimeout(this.idle);
    clearTimeout(this.deadline);
    for (const request of this.pending.values()) request.reject(new Error('Conversation history worker stopped'));
    this.pending.clear();
    this.closing = this.worker.terminate().then(() => {});
    await this.closing;
  }
}

let worker: ConversationHistoryWorker | undefined;
export function historyRequest<T>(command: HistoryCommand): Promise<T> {
  if (!worker?.available) worker = new ConversationHistoryWorker();
  return worker.request<T>(command);
}

let turnWorker: ConversationHistoryWorker | undefined;
let turnGeneration = 0;
/** A separate bounded lane keeps navigation scans out of interactive paging.
 * Same bootstrap, queue cap, timeout, redacted errors and idle-release policy. */
export async function turnIndexRequest<T>(command: HistoryCommand): Promise<T> {
  if (!turnWorker?.available) {
    // Do not overlap an interrupted writer with its replacement.
    const generation = turnGeneration;
    if (turnWorker) await turnWorker.close();
    if (generation !== turnGeneration) throw new Error('Conversation history worker stopped');
    if (!turnWorker?.available) turnWorker = new ConversationHistoryWorker();
  }
  return turnWorker.request<T>(command);
}

export async function closeConversationHistoryWorker(): Promise<void> {
  const current = worker;
  worker = undefined;
  const navigation = turnWorker;
  turnGeneration++;
  // Keep the stopped writer reachable until termination so an incoming read
  // cannot create a replacement while the old index is still being published.
  await Promise.all([current?.close(), navigation?.close()]);
  if (turnWorker === navigation) turnWorker = undefined;
}
