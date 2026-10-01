import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { WS_ROOT } from '../../paths';
import type { JsonlAppendSource } from '../../storage';

export interface ChatLiveMessage {
  cid: string;
  msgIndex: number;
  source?: JsonlAppendSource;
  message?: unknown;
  mark?: { mtime: number; size: number; next: number };
}

export interface ChatRebuildFile {
  fileKey: string;
  file: string;
  mtime: number;
  size: number;
}

export interface ChatRebuildBatch { valid: boolean; complete: boolean; next: number }

/** One serialized writer per account. Production live calls pass only file metadata;
 * source bodies, tokenization, postings writes and orphan deletion stay off
 * main. Main admits each batch, so cancellation never queues more work. */
export class ChatRebuildWorker {
  private worker: Worker;
  private pending?: { resolve: (value: any) => void; reject: (error: Error) => void };
  private failed = false;
  private closing = false;
  private tail: Promise<unknown> = Promise.resolve();
  private idle?: NodeJS.Timeout;
  private closed?: Promise<void>;

  get available(): boolean { return !this.failed && !this.closing; }

  constructor(userId: string) {
    this.worker = new Worker(path.join(__dirname, 'chat-rebuild-entry.js'), {
      workerData: { userId }, execArgv: [],
      env: { ...process.env, ORKAS_WORKSPACE_ROOT: WS_ROOT },
    });
    this.worker.on('message', (message) => {
      const pending = this.pending;
      this.pending = undefined;
      if (message.ok) pending?.resolve(message.value);
      else pending?.reject(new Error('Chat index rebuild batch failed'));
    });
    // Native/loader failures may contain source paths or content. Do not relay
    // their raw messages to main's logs or to the renderer.
    const fail = () => {
      this.failed = true;
      this.pending?.reject(new Error('Chat index rebuild worker stopped'));
      this.pending = undefined;
    };
    this.worker.on('error', fail);
    this.worker.on('exit', fail);
  }

  private send(command: object): Promise<any> {
    if (this.failed) return Promise.reject(new Error('Chat index rebuild worker unavailable'));
    if (this.pending) return Promise.reject(new Error('Chat index rebuild already has a pending batch'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.worker.postMessage(command); }
      catch { this.pending = undefined; reject(new Error('Chat index command could not be sent')); }
    });
  }

  private request(command: object): Promise<any> {
    if (!this.available) return Promise.reject(new Error('Chat index worker unavailable'));
    clearTimeout(this.idle);
    const run = this.tail.then(() => this.send(command));
    const settled = run.catch(() => undefined);
    this.tail = settled;
    void settled.then(() => {
      if (this.tail !== settled || !this.available) return;
      this.idle = setTimeout(() => { void this.close().catch(() => undefined); }, 30_000);
      this.idle.unref();
    });
    return run;
  }

  indexMessage(message: ChatLiveMessage): Promise<boolean> {
    return this.request({ kind: 'live', ...message });
  }

  invalidate(cid?: string): Promise<void> { return this.request({ kind: 'invalidate', cid }); }
  deleteConversation(cid: string): Promise<void> { return this.request({ kind: 'delete', cid }); }
  compact(): Promise<void> { return this.request({ kind: 'compact' }); }
  markComplete(stamp: string): Promise<void> { return this.request({ kind: 'complete', stamp }); }

  rebuildBatch(file: ChatRebuildFile): Promise<ChatRebuildBatch> {
    return this.request({ kind: 'batch', file });
  }

  deleteMissing(seen: string[]): Promise<number> {
    return this.request({ kind: 'prune', seen });
  }

  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    clearTimeout(this.idle);
    this.closed = (async () => {
      try { await this.tail; if (!this.failed) await this.send({ kind: 'close' }); }
      finally { await this.worker.terminate(); }
    })();
    return this.closed;
  }
}
