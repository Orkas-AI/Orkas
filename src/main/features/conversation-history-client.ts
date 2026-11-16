import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { WS_ROOT } from '../paths';

export type HistoryCommand = {
  kind: 'page' | 'window' | 'window-at-message' | 'project' | 'purge' | 'turns' | 'turn-purge' | 'process-page';
  userId: string;
  sourceFile: string;
  cid?: string;
  projectIdHint?: string | null;
  limit?: number;
  before?: number | null;
  after?: number;
  start?: number;
  messageId?: string;
  processRef?: string;
  processCursor?: number;
  records?: import('./group_chat/visibility').GroupMessage[];
};

/** Deliberate lifetime closure; worker crashes/timeouts keep ordinary errors. */
export class ConversationHistoryClosedError extends Error {
  readonly code = 'E_HISTORY_CLOSED';
  constructor() { super('Conversation history worker stopped'); }
}

/** Only projected rows cross back to main; idle workers release their heap. */
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

  async close(reason = new Error('Conversation history worker stopped')): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearTimeout(this.idle);
    clearTimeout(this.deadline);
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
    this.closing = this.worker.terminate().then(() => {});
    await this.closing;
  }
}

type HistoryWaiter = {
  command: HistoryCommand;
  key: string;
  deadline: number;
  timer?: NodeJS.Timeout;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  settled: boolean;
};
type HistorySlot = {
  worker: ConversationHistoryWorker;
  active?: HistoryWaiter;
  closing?: Promise<void>;
};

/** Persisted history has locator-only commands. Keep waiters here rather than
 * behind a busy Worker's raw parse/projection, with the original global cap.
 * Same-user/source commands own their key until completion or actual exit. */
class PersistedHistoryQueue {
  private slots: HistorySlot[] = [];
  private queue: HistoryWaiter[] = [];
  private activeKeys = new Set<string>();
  private pending = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private growth?: NodeJS.Timeout;
  private growReady = false;

  request<T>(command: HistoryCommand): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Conversation history worker stopped'));
    if (this.pending >= 128) return Promise.reject(new Error('Conversation history worker busy'));
    const sourceFile = path.resolve(command.sourceFile);
    this.pending++;
    return new Promise((resolve, reject) => {
      const job: HistoryWaiter = { command: { ...command, sourceFile },
        key: JSON.stringify([command.userId, sourceFile]), deadline: performance.now() + 120_000,
        resolve, reject, settled: false };
      // Waiting and execution consume one budget, not a fresh timeout per slot.
      job.timer = setTimeout(() => this.expire(job), 120_000);
      job.timer.unref();
      this.queue.push(job);
      this.pump();
    });
  }

  private settle(job: HistoryWaiter, error?: Error, value?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    this.pending--;
    if (error) job.reject(error);
    else job.resolve(value);
  }

  private rejectSource(key: string, error: Error): void {
    this.queue = this.queue.filter(job => {
      if (job.key !== key) return true;
      this.settle(job, error);
      return false;
    });
  }

  private retire(slot: HistorySlot, reason = new Error('Conversation history worker stopped')): Promise<void> {
    if (slot.closing) return slot.closing;
    slot.closing = slot.worker.close(reason).then(() => {
      const job = slot.active;
      if (job) {
        slot.active = undefined;
        this.activeKeys.delete(job.key);
        this.settle(job, reason);
        this.rejectSource(job.key, reason);
      }
      this.slots = this.slots.filter(current => current !== slot);
      this.pump();
    }, () => {
      // Failed termination cannot release a writer's key or execution slot.
      // Still settle its callers; close() propagates the redacted failure.
      const error = new Error('Conversation history worker stopped');
      if (slot.active) { this.settle(slot.active, error); this.rejectSource(slot.active.key, error); }
      throw error;
    });
    return slot.closing;
  }

  private expire(job: HistoryWaiter): void {
    if (job.settled) return;
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.settle(job, new Error('Conversation history worker stopped'));
      this.pump();
    } else {
      const slot = this.slots.find(current => current.active === job);
      // Keep the key and capacity until termination, even after timeout.
      if (slot) void this.retire(slot).catch(() => {});
    }
  }

  private pump(): void {
    if (this.stopped) return;
    for (const slot of this.slots) {
      if (!slot.worker.available) void this.retire(slot).catch(() => {});
    }
    while (this.queue.length) {
      const index = this.queue.findIndex(job => !this.activeKeys.has(job.key));
      if (index < 0) return;
      const job = this.queue[index];
      if (performance.now() >= job.deadline) { this.expire(job); continue; }
      let slot = this.slots.find(current => !current.active && !current.closing && current.worker.available);
      if (!slot && this.slots.length < 2) {
        // Warm reads usually release the first slot before another bootstrap
        // pays for itself. Keep this wait inside the job's total deadline.
        if (this.slots.length && !this.growReady) {
          if (!this.growth) {
            this.growth = setTimeout(() => { this.growth = undefined; this.growReady = true; this.pump(); }, 25);
            this.growth.unref();
          }
          return;
        }
        try {
          slot = { worker: new ConversationHistoryWorker() };
          this.slots.push(slot);
        } catch {
          this.queue.splice(index, 1);
          this.settle(job, new Error('Conversation history worker stopped'));
          continue;
        }
      }
      if (!slot) return;
      clearTimeout(this.growth);
      this.growth = undefined;
      this.growReady = false;
      this.queue.splice(index, 1);
      slot.active = job;
      this.activeKeys.add(job.key);
      const owner = slot;
      const complete = (error?: Error, value?: unknown) => {
        if (owner.closing || owner.active !== job) return;
        if (!owner.worker.available) { void this.retire(owner).catch(() => {}); return; }
        owner.active = undefined;
        this.activeKeys.delete(job.key);
        this.settle(job, error, value);
        this.pump();
      };
      owner.worker.request(job.command).then(value => complete(undefined, value), error => complete(error));
    }
    clearTimeout(this.growth);
    this.growth = undefined;
    this.growReady = false;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearTimeout(this.growth);
    const reason = new ConversationHistoryClosedError();
    for (const job of this.queue) this.settle(job, reason);
    this.queue = [];
    this.closing = Promise.all(this.slots.map(slot => this.retire(slot, reason))).then(() => {});
    return this.closing;
  }
}

let history: PersistedHistoryQueue | undefined;
let closingHistory: Promise<void> | undefined;
let lifetime = 0;
export function conversationHistoryLifetime(): number { return lifetime; }
export function historyRequest<T>(command: HistoryCommand): Promise<T> {
  // Closing rejects new admission instead of building another unbounded wait
  // queue outside the pool. A later explicit request can start a fresh lifetime.
  if (closingHistory) return Promise.reject(new ConversationHistoryClosedError());
  if (!history) history = new PersistedHistoryQueue();
  return history.request<T>(command);
}

let turnWorker: ConversationHistoryWorker | undefined;
let liveWorker: ConversationHistoryWorker | undefined;
/** Keep an active display projection out of the persisted-history queue.
 * The command and returned representation remain identical. */
export async function liveHistoryRequest<T>(command: HistoryCommand): Promise<T> {
  while (closingHistory) await closingHistory;
  if (!liveWorker?.available) {
    const generation = lifetime;
    if (liveWorker) await liveWorker.close();
    if (generation !== lifetime) throw new ConversationHistoryClosedError();
    if (!liveWorker?.available) liveWorker = new ConversationHistoryWorker();
  }
  return liveWorker.request<T>(command);
}
let turnGeneration = 0;
/** A separate bounded lane keeps navigation scans out of interactive paging.
 * Same bootstrap, queue cap, timeout, redacted errors and idle-release policy. */
export async function turnIndexRequest<T>(command: HistoryCommand): Promise<T> {
  while (closingHistory) await closingHistory;
  if (!turnWorker?.available) {
    // Do not overlap an interrupted writer with its replacement.
    const generation = turnGeneration;
    if (turnWorker) await turnWorker.close();
    if (generation !== turnGeneration) throw new ConversationHistoryClosedError();
    if (!turnWorker?.available) turnWorker = new ConversationHistoryWorker();
  }
  return turnWorker.request<T>(command);
}

export function closeConversationHistoryWorker(): Promise<void> {
  lifetime++;
  turnGeneration++;
  if (closingHistory) return closingHistory;
  const current = history;
  const navigation = turnWorker;
  const live = liveWorker;
  // Keep the stopped writer reachable until termination so an incoming read
  // cannot create a replacement while the old index is still being published.
  const reason = new ConversationHistoryClosedError();
  const closing = Promise.all([current?.close(), navigation?.close(reason), live?.close(reason)]).then(() => {
    if (history === current) history = undefined;
    if (liveWorker === live) liveWorker = undefined;
    if (turnWorker === navigation) turnWorker = undefined;
    // A rejected termination has not confirmed the old writer's exit. Keep
    // every lane closed rather than admitting a cold lane beside that writer.
    if (closingHistory === closing) closingHistory = undefined;
  });
  closingHistory = closing;
  return closing;
}
