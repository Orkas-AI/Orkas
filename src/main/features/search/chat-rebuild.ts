import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { WS_ROOT } from '../../paths';

export interface ChatRebuildFile {
  fileKey: string;
  file: string;
  mtime: number;
  size: number;
}

export interface ChatRebuildBatch { valid: boolean; complete: boolean; next: number }

/** One writer per reconcile pass. Only file metadata crosses this boundary;
 * source bodies, tokenization, postings writes and orphan deletion stay off
 * main. Main admits each batch, so cancellation never queues more work. */
export class ChatRebuildWorker {
  private worker: Worker;
  private pending?: { resolve: (value: any) => void; reject: (error: Error) => void };
  private failed = false;

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

  private request(command: object): Promise<any> {
    if (this.failed) return Promise.reject(new Error('Chat index rebuild worker unavailable'));
    if (this.pending) return Promise.reject(new Error('Chat index rebuild already has a pending batch'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(command);
    });
  }

  rebuildBatch(file: ChatRebuildFile): Promise<ChatRebuildBatch> {
    return this.request({ kind: 'batch', file });
  }

  deleteMissing(seen: string[]): Promise<number> {
    return this.request({ kind: 'prune', seen });
  }

  async close(): Promise<void> {
    try { if (!this.failed) await this.request({ kind: 'close' }); }
    finally { await this.worker.terminate(); }
  }
}
