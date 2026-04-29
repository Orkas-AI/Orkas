/**
 * Singleton wrapper around `fastembed`'s FlagEmbedding. Initialized lazily on
 * the first `embed()` call — model load is ~1-2s (tokenizer + ONNX session).
 * Subsequent calls reuse the session.
 *
 * Embedder is global (not per-uid): the model is identical for every user,
 * just a shared inference engine. There's no per-uid state.
 *
 * A previous iteration spawned 2 `worker_threads` each holding its own
 * FlagEmbedding to get real parallelism. That crashed hard (SIGSEGV) during
 * vectorization — two `worker_threads` both racing onnxruntime-node's native
 * init (OpenMP threadpool + native allocators) is a known-unsafe pattern.
 * Reverted to single-session; parallelism lives on the cross-file pipeline
 * in `kb_indexer.ts` instead. If we want true embed parallelism in future,
 * use `child_process` (separate OS process per session) rather than threads.
 *
 * Testability: the whole module is mock-friendly via `vi.mock('../features/kb_embed')`.
 * Tests should mock to avoid the 95MB model load on every test run.
 */

import { Mutex } from 'async-mutex';

import { embeddingModelDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('kb_embed');

/**
 * Chunks per forward pass. Kept at 32 — previously tried 64 and hit a hard
 * onnxruntime-node crash (`SIGTRAP` inside `BFCArena::AllocateRawInternal`
 * during the transformer attention compute) because attention memory scales
 * `batch × seq²`: doubling the batch doubles the peak allocation, which
 * pushed it past what Electron's process could service. 32 is the known-
 * stable ceiling for bge-small-zh on desktop hardware.
 */
const EMBED_BATCH_SIZE = 32;

// Loaded lazily via dynamic import since fastembed is ESM / loads onnxruntime
// eagerly. Keeping it dynamic means test code that mocks this module never
// touches fastembed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embedder: any = null;
const _initLock = new Mutex();

async function initEmbedder(): Promise<void> {
  if (_embedder) return;
  await _initLock.runExclusive(async () => {
    if (_embedder) return;
    const started = Date.now();
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    _embedder = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallZH,
      cacheDir: embeddingModelDir(),
      // Model files come bundled with the installer (see resources/embedding-model);
      // any attempt to download is a bug — never silently spinner-download.
      showDownloadProgress: false,
    });
    log.info(`initialized in ${Date.now() - started}ms (model=bge-small-zh-v1.5, dim=512)`);
  });
}

/**
 * Produce a 512-dim unit-normalised embedding for each input text. Preserves
 * input order 1:1. Throws on empty input or model load failure.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  await initEmbedder();
  const out: number[][] = [];
  const gen = _embedder.embed(texts, EMBED_BATCH_SIZE);
  for await (const batch of gen) {
    // Each yield: batch of TypedArray / number[] embeddings. Normalise to plain
    // number[] so downstream encoding to Float32Array is unambiguous.
    for (const v of batch) {
      out.push(Array.isArray(v) ? v : Array.from(v as ArrayLike<number>));
    }
  }
  if (out.length !== texts.length) {
    throw new Error(`embed count mismatch: ${out.length} vectors vs ${texts.length} texts`);
  }
  return out;
}

/** Embed a single query. Shortcut for `embedTexts([q])[0]`. */
export async function embedQuery(query: string): Promise<number[]> {
  const vs = await embedTexts([query]);
  return vs[0];
}

/** Close + release the ONNX session. Should be called on app shutdown. */
export function closeEmbedder(): void {
  if (!_embedder) return;
  try {
    // fastembed doesn't expose a release API; we just drop the reference and
    // let GC clean up the ONNX InferenceSession. onnxruntime-node has a known
    // mutex race on process-exit teardown — harmless but noisy.
    _embedder = null;
  } catch (err) {
    log.warn(`close: ${(err as Error).message}`);
  }
}
