import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const signature = (s: fs.BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
const stamp = (file: string) => {
  const s = fs.lstatSync(file, { bigint: true });
  return s.isFile() ? signature(s) : '';
};

/** Read a fixed length from the verified handle. Growth cannot keep a check
 * reading forever, and source bodies are never buffered whole in main memory. */
async function digest(file: string, expected: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('bundle check cancelled');
  if (signature(await fsp.lstat(file, { bigint: true })) !== expected) throw new Error('bundle source changed');
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || signature(before) !== expected) throw new Error('bundle source changed');
    const length = Number(before.size);
    if (!Number.isSafeInteger(length)) throw new Error('unsupported bundle entry');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, length));
    for (let offset = 0; offset < length;) {
      if (signal?.aborted) throw new Error('bundle check cancelled');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (!bytesRead) throw new Error('bundle source changed');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (signature(await handle.stat({ bigint: true })) !== expected || stamp(file) !== expected) throw new Error('bundle source changed');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/** Freeze inventory and content identities at launch. Metadata can reject a
 * revision cheaply, but cannot prove unchanged bytes. Privileged consumers
 * await valid(); synchronous cancellation/navigation guards use current(). */
export async function bundleRevision(root: string, required: string[], requiredContents: ReadonlyMap<string, Buffer> = new Map()) {
  const files = new Map<string, { stamp: string; digest: string }>();
  const loaded = new Set(required.map(p => path.resolve(p)));
  let invalid = false;
  // Manifest authority and the entry were resolved before the asynchronous
  // inventory. They must not change while that inventory yields to the host.
  const requiredStamps = new Map([...loaded].map(file => [file, stamp(file)]));
  const requiredDigests = new Map([...requiredContents].map(([file, bytes]) =>
    [path.resolve(file), crypto.createHash('sha256').update(bytes).digest('hex')]));
  const pending = [path.resolve(root)];
  while (pending.length) {
    const dir = pending.pop()!;
    if (!(await fsp.lstat(dir)).isDirectory()) throw new Error('unsupported bundle entry');
    const directory = await fsp.opendir(dir);
    for await (const item of directory) {
      if (item.name.startsWith('.')) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) pending.push(file);
      else if (item.isFile()) {
        const s = await fsp.lstat(file, { bigint: true });
        if (!s.isFile()) throw new Error('unsupported bundle entry');
        const identity = signature(s);
        files.set(file, { stamp: identity, digest: await digest(file, identity) });
      } else throw new Error('unsupported bundle entry');
    }
  }
  const same = (file: string) => {
    try { return files.get(file)?.stamp === stamp(file); } catch { return false; }
  };
  const current = () => {
    if (!invalid) for (const file of loaded) if (!same(file)) { invalid = true; break; }
    return !invalid;
  };
  for (const [file, original] of requiredStamps) {
    const recorded = files.get(file);
    const content = requiredDigests.get(file);
    if (!original || recorded?.stamp !== original || !same(file)
      || (content && content !== recorded.digest)) {
      throw new Error('bundle changed during launch');
    }
  }
  // Serialize reads per revision, bounding scratch memory and disk fan-out.
  // Each queued caller reads afresh; no TTL or timestamp-based success cache.
  let tail: Promise<unknown> = Promise.resolve();
  const valid = (signal?: AbortSignal): Promise<boolean> => {
    const check = tail.then(async () => {
      if (signal?.aborted) return false;
      if (!current()) return false;
      try {
        for (const file of loaded) {
          const recorded = files.get(file)!;
          if (await digest(file, recorded.stamp, signal) !== recorded.digest) { invalid = true; return false; }
        }
        return current();
      } catch { if (!signal?.aborted) invalid = true; return false; }
    });
    tail = check;
    return check;
  };
  if (!await valid()) throw new Error('bundle changed during launch');
  return {
    current, valid,
    accept(file: string) {
      file = path.resolve(file);
      if (invalid || !same(file)) { invalid = true; return false; }
      loaded.add(file);
      return true;
    },
  };
}
