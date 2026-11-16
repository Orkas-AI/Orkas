import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonSync } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { resolveSandboxEntry } from '../../util/path-sandbox';

type Status = 'started' | 'retryable' | 'failed' | 'published' | 'unknown';
export class OfficeCreationStateError extends Error {
  constructor() { super('Office creation state could not be verified or saved; do not repeat the creation.'); }
}
export interface OfficeCreation {
  version: 1;
  id: string;
  requestedPath: string;
  finalPath?: string;
  fingerprint: string;
  attempt: 1 | 2;
  status: Status;
}

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_RECORD_BYTES = 32 * 1024;
const keyFor = (value: string) => createHash('sha256').update(value).digest('hex');
const pathIdentity = (value: string) => {
  const resolved = resolveSandboxEntry(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Host-owned operation evidence, independent of artifact existence and model
 * history. Production supplies conversation-owned retained storage. Direct
 * isolated callers may keep a factory-local journal instead. No scan or expiry
 * can turn an uncertain operation into a new one. */
export class OfficeCreationJournal {
  private readonly memory = new Map<string, unknown>();
  private readonly lockKey: string;
  constructor(private readonly directory?: string) {
    this.lockKey = directory ? path.resolve(directory) : `office-creation:${randomUUID()}`;
  }

  private read(name: string): any {
    if (!this.directory) return this.memory.get(name);
    const file = path.join(this.directory, `${name}.json`);
    try {
      if (fs.statSync(file).size > MAX_RECORD_BYTES) throw new Error('Invalid creation record');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new OfficeCreationStateError();
    }
  }

  private write(name: string, value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RECORD_BYTES) throw new Error('Invalid creation record');
    try {
      if (this.directory) writeJsonSync(path.join(this.directory, `${name}.json`), value);
      else this.memory.set(name, structuredClone(value));
    } catch { throw new OfficeCreationStateError(); }
  }

  private operation(id: string): OfficeCreation {
    if (!ID.test(id)) throw new Error('Invalid creation identity');
    const value = this.read(`operation-${id}`);
    if (!value || value.version !== 1 || value.id !== id
      || typeof value.requestedPath !== 'string' || !path.isAbsolute(value.requestedPath)
      || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
      || ![1, 2].includes(value.attempt)
      || !['started', 'retryable', 'failed', 'published', 'unknown'].includes(value.status)
      || (value.finalPath !== undefined && (typeof value.finalPath !== 'string' || !path.isAbsolute(value.finalPath)))) {
      throw new Error('Invalid creation record');
    }
    return value;
  }

  private atPath(target: string): OfficeCreation | undefined {
    const ref = this.read(`path-${keyFor(target)}`);
    if (ref === undefined) return undefined;
    if (!ref || typeof ref.id !== 'string') throw new Error('Invalid creation reference');
    const operation = this.operation(ref.id);
    if (operation.requestedPath !== target && (!operation.finalPath || pathIdentity(operation.finalPath) !== target)) throw new Error('Invalid creation binding');
    return operation;
  }

  async begin(target: string, fingerprint: string, retryOf: unknown, allowExistingWord: boolean): Promise<{
    operation?: OfficeCreation; error?: string;
  }> {
    target = pathIdentity(target);
    return fileEditLock(this.lockKey).runExclusive(() => {
      const prior = this.atPath(target);
      if (retryOf !== undefined) {
        if (typeof retryOf !== 'string' || !ID.test(retryOf)) return { error: 'retry_of must identify the original failed creation.' };
        // Looking up by the original operation also prevents a changed filename
        // from allocating fresh correction allowance.
        const original = this.operation(retryOf);
        if (!prior || prior.id !== original.id || original.requestedPath !== target) {
          return { error: 'A correction must retain its original requested path.' };
        }
        if (original.status !== 'retryable' || original.attempt !== 1) {
          return { operation: original, error: 'This creation has no correction attempt available.' };
        }
        if (original.fingerprint === fingerprint) return { operation: original, error: 'Correct the rejected input before retrying.' };
        const operation: OfficeCreation = { ...original, fingerprint, attempt: 2, status: 'started' };
        this.write(`operation-${operation.id}`, operation);
        return { operation };
      }
      if (prior && !(allowExistingWord && prior.status === 'published' && fs.existsSync(prior.finalPath || target))) {
        return { operation: prior, error: prior.status === 'retryable'
          ? 'Use retry_of with this failed operation_id for its one corrected attempt.'
          : 'This creation cannot be repeated. Edit the existing artifact; a missing file does not authorize recreation.' };
      }
      const operation: OfficeCreation = { version: 1, id: randomUUID(), requestedPath: target, fingerprint, attempt: 1, status: 'started' };
      // Reserve the path first. A crash before the record write leaves a broken
      // reference that fails closed, never an untracked dispatched creation.
      this.write(`path-${keyFor(target)}`, { id: operation.id });
      this.write(`operation-${operation.id}`, operation);
      return { operation };
    });
  }

  async bindFinal(operation: OfficeCreation, finalPath: string): Promise<void> {
    const finalIdentity = pathIdentity(finalPath);
    await fileEditLock(this.lockKey).runExclusive(() => {
      const current = this.operation(operation.id);
      if (current.attempt !== operation.attempt || current.status !== 'started') throw new Error('Stale creation attempt');
      const prior = this.atPath(finalIdentity);
      if (prior && prior.id !== current.id && finalIdentity !== current.requestedPath) throw new Error('Creation destination already reserved');
      const next = { ...current, finalPath };
      this.write(`operation-${current.id}`, next);
      this.write(`path-${keyFor(finalIdentity)}`, { id: current.id });
      // An exclusive publication may encounter an outside writer after binding.
      // Release only our old suffix claim; the original requested identity and
      // current final binding still prevent any replay of this operation.
      if (current.finalPath) {
        const previous = pathIdentity(current.finalPath);
        if (previous !== current.requestedPath && previous !== finalIdentity) {
          const name = `path-${keyFor(previous)}`;
          const reference = this.read(name);
          if (reference?.id === current.id) {
            try {
              if (this.directory) fs.rmSync(path.join(this.directory, `${name}.json`), { force: true });
              else this.memory.delete(name);
            } catch { throw new OfficeCreationStateError(); }
          }
        }
      }
      Object.assign(operation, next);
    });
  }

  async finish(operation: OfficeCreation, status: Status): Promise<void> {
    await fileEditLock(this.lockKey).runExclusive(() => {
      const current = this.operation(operation.id);
      if (current.attempt !== operation.attempt || current.status !== 'started') throw new Error('Stale creation attempt');
      const next = { ...current, status };
      this.write(`operation-${current.id}`, next);
      Object.assign(operation, next);
    });
  }
}

export function officeCreationReceipt(operation: OfficeCreation): string {
  return `\n<office-creation>${JSON.stringify({
    operation_id: operation.id,
    publication: operation.status === 'published' ? 'published'
      : ['retryable', 'failed'].includes(operation.status) ? 'not_published' : 'unknown',
    retry_available: operation.status === 'retryable' && operation.attempt === 1,
    attempt: operation.attempt,
    ...(operation.status === 'published' && operation.finalPath ? { artifact_path: operation.finalPath } : {}),
  })}</office-creation>`;
}
