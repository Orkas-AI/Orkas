'use strict';

/**
 * KB embedder worker — runs `fastembed`'s FlagEmbedding (onnxruntime-node) in a
 * dedicated Electron `utilityProcess`, ISOLATED from the main process.
 *
 * Why a separate process: onnxruntime-node's native inference has crashed the
 * host hard before (SIGSEGV during vectorization; SIGTRAP inside
 * `BFCArena::AllocateRawInternal` on oversized batches). A native fault can't
 * be caught by any JS handler, so in-process it took the WHOLE app down (every
 * window + in-flight conversation). Here a crash only kills this worker; the
 * supervisor (`features/kb_embed.ts`) fails the current batch and respawns.
 *
 * Protocol over `parentPort` (structured clone):
 *   parent → worker: { id, type: 'embed', texts: string[], batchSize?: number }
 *   worker → parent: { id, ok: true, vectors: number[][] }
 *                  | { id, ok: false, error: string }
 *
 * Model files are pre-bundled (installer ships resources/embedding-model); the
 * supervisor passes their dir via ORKAS_EMBED_MODEL_DIR. Any download attempt
 * would be a bug — showDownloadProgress stays false.
 *
 * This file is plain CommonJS on purpose: utilityProcess runs it as-is with no
 * tsx hook, and it resolves `fastembed` from the (asar-unpacked) node_modules
 * exactly like the in-process require did.
 */

const DEFAULT_EMBED_BATCH_SIZE = 32;

function nativeEmbedLoadCode(err) {
  if (!err || err.code !== 'ERR_DLOPEN_FAILED') return '';
  const details = [err.message, err.stack]
    .map((value) => String(value || '').toLowerCase())
    .join('\n');
  if (details.includes('onnxruntime')) return 'E_LIBRARY_NATIVE_ONNX_LOAD';
  if (details.includes('tokenizers')) return 'E_LIBRARY_NATIVE_TOKENIZERS_LOAD';
  return 'E_LIBRARY_NATIVE_EMBED_LOAD';
}

let _embedder = null;
let _initPromise = null;

async function initEmbedder() {
  if (_embedder) return _embedder;
  if (!_initPromise) {
    _initPromise = (async () => {
      // CJS entry (fastembed's ESM entry imports `tar` as a default export,
      // which breaks with tar@7) — same require the in-process path used.
      const { FlagEmbedding, EmbeddingModel } = require('fastembed');
      const cacheDir = process.env.ORKAS_EMBED_MODEL_DIR || undefined;
      const em = await FlagEmbedding.init({
        model: EmbeddingModel.BGESmallZH,
        cacheDir,
        showDownloadProgress: false,
      });
      _embedder = em;
      return em;
    })().catch((err) => {
      // Let the next request retry init rather than wedging on a stuck promise.
      _initPromise = null;
      throw err;
    });
  }
  return _initPromise;
}

async function embed(texts, batchSize) {
  const em = await initEmbedder();
  const out = [];
  const gen = em.embed(texts, batchSize || DEFAULT_EMBED_BATCH_SIZE);
  for await (const batch of gen) {
    for (const v of batch) out.push(Array.isArray(v) ? v : Array.from(v));
  }
  return out;
}

if (!process.parentPort) {
  // Not spawned as a utilityProcess — nothing sane to do.
  process.exit(1);
}

// Serialize embed handling: a single onnxruntime session is not concurrency-
// safe, so one embed at a time (matches the previous in-process behavior; the
// cross-file pipeline parallelism lives in kb_indexer.ts, not here).
let _chain = Promise.resolve();

process.parentPort.on('message', (event) => {
  const msg = (event && event.data) || {};
  if (!msg || msg.type !== 'embed') return;
  const id = msg.id;
  const texts = Array.isArray(msg.texts) ? msg.texts : [];
  const batchSize = msg.batchSize;
  _chain = _chain.then(async () => {
    try {
      const vectors = await embed(texts, batchSize);
      process.parentPort.postMessage({ id, ok: true, vectors });
    } catch (err) {
      const errorCode = nativeEmbedLoadCode(err);
      process.parentPort.postMessage({
        id,
        ok: false,
        error: errorCode ? 'native embedding runtime failed to load' : ((err && err.message) || String(err)),
        ...(errorCode ? { errorCode } : {}),
      });
    }
  });
});
