/** Machine-private request identities and completed outputs; no account spending state. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { appConversationRoot, userLocalRoot } from '../paths';
import { writeJson } from '../storage';
import { fileEditLock } from '../util/locks';

export type ProductionRequestKind = 'image' | 'video';
type RequestKey = { userId: string; scope: string };
export type ProductionRequestRecord = {
  kind: ProductionRequestKind;
  state: 'reserved' | 'settled';
  at: string;
  output?: string;
  video_route?: string;
  production?: { dir: string; shot: string };
};
type RequestBook = { version: 1; scope: string; entries: Record<string, ProductionRequestRecord> };

export function productionRequestStatePath({ userId, scope }: RequestKey): string {
  const id = createHash('sha256').update(scope).digest('hex').slice(0, 32);
  const root = appConversationRoot(userId, scope) ?? userLocalRoot(userId);
  return path.join(root, 'video_studio', 'requests', `${id}.json`);
}

async function readRequests(file: string): Promise<RequestBook | null> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('The generation request history could not be read. It was preserved.');
  }
  try {
    const book = JSON.parse(raw) as RequestBook;
    if (book?.version !== 1 || typeof book.scope !== 'string' || !book.entries
      || typeof book.entries !== 'object' || Array.isArray(book.entries)) throw new Error();
    for (const entry of Object.values(book.entries)) {
      if (!entry || !['image', 'video'].includes(entry.kind) || !['reserved', 'settled'].includes(entry.state)
        || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
        || (entry.output !== undefined && typeof entry.output !== 'string')
        || (entry.video_route !== undefined && typeof entry.video_route !== 'string')
        || (entry.production !== undefined && (!entry.production || typeof entry.production !== 'object'
          || typeof entry.production.dir !== 'string' || typeof entry.production.shot !== 'string'))) throw new Error();
    }
    return book;
  } catch {
    throw new Error('The generation request history could not be read. It was preserved.');
  }
}

export async function productionRequestHold(input: RequestKey & { fingerprint: string }): Promise<ProductionRequestRecord | null> {
  const book = await readRequests(productionRequestStatePath(input));
  return book && Object.hasOwn(book.entries, input.fingerprint) ? book.entries[input.fingerprint] : null;
}

/** Reserve one structured identity atomically. A pending identity is not permission to replay it. */
export async function reserveProductionRequest(input: RequestKey & {
  fingerprint: string;
  kind: ProductionRequestKind;
  sendAgain?: boolean;
  videoRoute?: string;
  production?: { dir: string; shot: string };
}): Promise<{ status: 'reserved' | 'already_reserved' | 'already_settled' }> {
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error('Invalid generation request identity.');
  const file = productionRequestStatePath(input);
  return fileEditLock(file).runExclusive(async () => {
    const book: RequestBook = await readRequests(file) ?? { version: 1, scope: input.scope, entries: {} };
    const existing = Object.hasOwn(book.entries, input.fingerprint) ? book.entries[input.fingerprint] : undefined;
    if (existing && !(input.sendAgain && existing.state === 'settled')) {
      return { status: existing.state === 'settled' ? 'already_settled' : 'already_reserved' };
    }
    if (existing) {
      const stem = `${input.fingerprint}#${existing.at}`;
      let key = stem;
      for (let index = 2;Object.hasOwn(book.entries, key);index += 1) key = `${stem}#${index}`;
      book.entries[key] = existing;
    }
    book.entries[input.fingerprint] = {
      kind: input.kind,
      state: 'reserved',
      at: new Date().toISOString(),
      ...(input.videoRoute ? { video_route: input.videoRoute } : {}),
      ...(input.production ? { production: input.production } : {}),
    };
    await writeJson(file, book);
    return { status: 'reserved' };
  });
}

export async function settleProductionRequest(input: RequestKey & { fingerprint: string; output?: string }): Promise<void> {
  const file = productionRequestStatePath(input);
  await fileEditLock(file).runExclusive(async () => {
    const book = await readRequests(file);
    const entry = book && Object.hasOwn(book.entries, input.fingerprint) ? book.entries[input.fingerprint] : undefined;
    if (!book || !entry) throw new Error('Generation request reservation is unavailable.');
    entry.state = 'settled';
    if (input.output) entry.output = input.output;
    await writeJson(file, book);
  });
}

/** Only a definite failure before dispatch releases a pending identity. */
export async function releaseProductionRequest(input: RequestKey & { fingerprint: string }): Promise<void> {
  const file = productionRequestStatePath(input);
  await fileEditLock(file).runExclusive(async () => {
    const book = await readRequests(file);
    if (!book || !Object.hasOwn(book.entries, input.fingerprint) || book.entries[input.fingerprint].state === 'settled') return;
    delete book.entries[input.fingerprint];
    await writeJson(file, book);
  });
}

/** Local request facts only; no provider charge or account-balance assertion. */
export async function productionRequestStatus(input: RequestKey): Promise<{ pending: number; completed: number }> {
  const book = await readRequests(productionRequestStatePath(input));
  const counts = { pending: 0, completed: 0 };
  for (const entry of Object.values(book?.entries ?? {})) {
    if (entry.state === 'reserved') counts.pending += 1;
    else counts.completed += 1;
  }
  return counts;
}

/** A canvas shot stays blocked while any earlier generation for it is unresolved. */
export async function hasPendingProductionRequest(input: RequestKey & {
  productionDirAbs: string;
  shot: string;
  kind: ProductionRequestKind;
}): Promise<boolean> {
  const book = await readRequests(productionRequestStatePath(input));
  return Object.values(book?.entries ?? {}).some(entry => entry.state === 'reserved' && entry.kind === input.kind
    && entry.production?.shot === input.shot
    && path.resolve(entry.production.dir) === path.resolve(input.productionDirAbs));
}
