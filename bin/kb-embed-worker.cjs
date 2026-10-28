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
 * would be a bug — use the SDK local-model entry, which never retrieves it.
 *
 * This file is plain CommonJS on purpose: utilityProcess runs it as-is with no
 * tsx hook. Resolve dependencies through the logical application root: the
 * physical unpacked tree does not contain every JavaScript dependency.
 */

const path = require('node:path');
const { createRequire } = require('node:module');
const requireApp = createRequire(path.join(__dirname, '..', 'package.json')
  .replace(/([\\/])app\.asar\.unpacked([\\/])/g, '$1app.asar$2'));

const DEFAULT_EMBED_BATCH_SIZE = 32;

function useBatchPadding(session) {
  // FastEmbed tokenizes with a fixed 512-token ceiling and owns CLS pooling
  // and normalization. Adapt only its session feeds: remove columns masked
  // out in every row, preserving all token positions and the SDK output path.
  // This instance-local adapter relies on the installed SDK's session field;
  // the worker contracts exercise it with the real SDK and tokenizer.
  const run = session.run.bind(session);
  session.run = (feeds, ...args) => {
    const mask = feeds.attention_mask;
    const [rows, width] = mask.dims;
    let batchWidth = 1;
    for (let row = 0; row < rows; row++) {
      let end = width;
      while (end > batchWidth && Number(mask.data[row * width + end - 1]) === 0) end--;
      batchWidth = Math.max(batchWidth, end);
    }
    if (batchWidth === width) return run(feeds, ...args);
    const compact = { ...feeds };
    for (const name of ['input_ids', 'attention_mask', 'token_type_ids']) {
      const tensor = feeds[name];
      if (tensor.dims.length !== 2 || tensor.dims[0] !== rows || tensor.dims[1] !== width) {
        throw new Error('embedding input dimensions do not match');
      }
      const data = new tensor.data.constructor(rows * batchWidth);
      for (let row = 0; row < rows; row++) {
        data.set(tensor.data.subarray(row * width, row * width + batchWidth), row * batchWidth);
      }
      compact[name] = new tensor.constructor(tensor.type, data, [rows, batchWidth]);
    }
    return run(compact, ...args);
  };
}

function nativeEmbedLoadCode(err) {
  if (!err || err.code !== 'ERR_DLOPEN_FAILED') return '';
  const details = [err.message, err.stack]
    .map((value) => String(value || '').toLowerCase())
    .join('\n');
  if (details.includes('onnxruntime')) return 'E_LIBRARY_NATIVE_ONNX_LOAD';
  if (details.includes('tokenizers')) return 'E_LIBRARY_NATIVE_TOKENIZERS_LOAD';
  return 'E_LIBRARY_NATIVE_EMBED_LOAD';
}

function unavailableModelError() {
  return Object.assign(new Error('bundled embedding model unavailable'), {
    code: 'E_LIBRARY_EMBED_MODEL_UNAVAILABLE',
  });
}

let _embedder = null;
let _initPromise = null;

async function initEmbedder() {
  if (_embedder) return _embedder;
  if (!_initPromise) {
    _initPromise = (async () => {
      // CJS entry (fastembed's ESM entry imports `tar` as a default export,
      // which breaks with tar@7) — same require the in-process path used.
      const { FlagEmbedding, EmbeddingModel } = requireApp('fastembed');
      const cacheDir = process.env.ORKAS_EMBED_MODEL_DIR;
      if (!cacheDir || !path.isAbsolute(cacheDir)) throw unavailableModelError();
      let em;
      try {
        // BGESmallZH's cache entry downloads when absent. CUSTOM names the
        // exact same bundled model/tokenizer without entering retrieveModel,
        // including if files disappear between validation and initialization.
        em = await FlagEmbedding.init({
          model: EmbeddingModel.CUSTOM,
          modelAbsoluteDirPath: path.join(cacheDir, EmbeddingModel.BGESmallZH),
          modelName: 'model_optimized.onnx',
          maxLength: 512,
          showDownloadProgress: false,
        });
      } catch (err) {
        if (nativeEmbedLoadCode(err)) throw err;
        throw unavailableModelError();
      }
      useBatchPadding(em.session);
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
      const errorCode = nativeEmbedLoadCode(err)
        || (err && err.code === 'E_LIBRARY_EMBED_MODEL_UNAVAILABLE' ? err.code : '');
      process.parentPort.postMessage({
        id,
        ok: false,
        error: errorCode === 'E_LIBRARY_EMBED_MODEL_UNAVAILABLE'
          ? 'bundled embedding model unavailable'
          : errorCode ? 'native embedding runtime failed to load' : ((err && err.message) || String(err)),
        ...(errorCode ? { errorCode } : {}),
      });
    }
  });
});
