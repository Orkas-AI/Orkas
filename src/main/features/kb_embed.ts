/**
 * KB embedder — supervisor for an ISOLATED `fastembed` (bge-small-zh) worker.
 *
 * The ONNX inference runs in a dedicated Electron `utilityProcess`
 * (`bin/kb-embed-worker.cjs`), NOT in the main process. onnxruntime-node's
 * native inference has taken the whole app down before (SIGSEGV during
 * vectorization; SIGTRAP inside `BFCArena::AllocateRawInternal` on batch=64) —
 * a native fault escapes every JS handler, so in-process a bad chunk/batch/
 * platform build killed every window + in-flight conversation. Out-of-process,
 * a crash only kills the worker: in-flight embeds reject and the next call
 * respawns. Mirrors the isolation `ocr_runtime.ts` already has for its ONNX.
 *
 * Public API (`embedTexts` / `embedQuery` / `closeEmbedder`) is unchanged, so
 * every caller (vec_store, kb_indexer, project_library_indexer, rerank/kb
 * tools) and every `vi.mock('../features/kb_embed')` keep working as-is.
 *
 * The embedder is global (model is identical for all users; no per-uid state).
 * Concurrency: the worker serializes embeds on one session; the supervisor
 * multiplexes concurrent callers by request id and the worker answers in order.
 */

import * as path from 'node:path';

import { embeddingModelDir, PC_ROOT } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('kb_embed');

const EMBED_BATCH_SIZE = 32;

// If the worker dies this many times inside the window, stop respawning for a
// cooldown and fail fast — a persistent native fault (bad platform build) must
// not become a tight respawn + 95MB-model-reload loop.
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 4;
const CRASH_COOLDOWN_MS = 30_000;

function nativeEmbedLoadCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== 'ERR_DLOPEN_FAILED') return '';
  const details = [
    (err as { message?: unknown } | null)?.message,
    (err as { stack?: unknown } | null)?.stack,
  ].map((value) => String(value || '').toLowerCase()).join('\n');
  if (details.includes('onnxruntime')) return 'E_LIBRARY_NATIVE_ONNX_LOAD';
  if (details.includes('tokenizers')) return 'E_LIBRARY_NATIVE_TOKENIZERS_LOAD';
  return 'E_LIBRARY_NATIVE_EMBED_LOAD';
}

function embedWorkerError(msg: { error?: unknown; errorCode?: unknown }): Error {
  const code = String(msg.errorCode || '');
  const component = code === 'E_LIBRARY_NATIVE_ONNX_LOAD'
    ? 'onnxruntime'
    : code === 'E_LIBRARY_NATIVE_TOKENIZERS_LOAD'
      ? 'tokenizers'
      : code === 'E_LIBRARY_NATIVE_EMBED_LOAD'
        ? 'embedding runtime'
        : '';
  const err = new Error(component
    ? `${component} native module failed to load`
    : String(msg.error || 'embed failed')) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

/** Minimal transport the supervisor needs from a worker. The default wraps an
 *  Electron utilityProcess; tests inject a fake so the correlation + crash
 *  logic runs without an Electron runtime. */
export interface EmbedChannel {
  postMessage(msg: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

type ChannelFactory = () => EmbedChannel;

let _channel: EmbedChannel | null = null;
let _reqSeq = 0;
const _pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();
let _crashTimes: number[] = [];
let _cooldownUntil = 0;

let _channelFactory: ChannelFactory | null = null;

/** Test seam: inject a fake channel factory (null → real utilityProcess). */
export function _setEmbedChannelFactoryForTest(factory: ChannelFactory | null): void {
  _teardownChannel(new Error('embed channel factory replaced'));
  _channelFactory = factory;
  _crashTimes = [];
  _cooldownUntil = 0;
}

function _defaultChannelFactory(): EmbedChannel {
  // Lazy require — Electron isn't present under vitest, and this path is never
  // reached in tests (they inject a factory).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { app, utilityProcess } = require('electron') as typeof import('electron');
  const packaged = !!app && app.isPackaged;
  const base = packaged ? PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked') : PC_ROOT;
  const scriptPath = path.join(base, 'bin', 'kb-embed-worker.cjs');
  const child = utilityProcess.fork(scriptPath, [], {
    serviceName: 'orkas-kb-embed',
    env: { ...process.env, ORKAS_EMBED_MODEL_DIR: embeddingModelDir() },
  });
  return {
    postMessage: (msg) => child.postMessage(msg),
    onMessage: (cb) => child.on('message', (msg) => cb(msg)),
    onExit: (cb) => child.on('exit', (code) => cb(code)),
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

function _teardownChannel(reason: Error): void {
  const ch = _channel;
  _channel = null;
  if (ch) { try { ch.kill(); } catch { /* ignore */ } }
  if (_pending.size) {
    const pend = [..._pending.values()];
    _pending.clear();
    for (const p of pend) p.reject(reason);
  }
}

function _ensureChannel(): EmbedChannel {
  if (_channel) return _channel;
  const now = Date.now();
  if (now < _cooldownUntil) {
    throw new Error('embedder worker is cooling down after repeated crashes');
  }
  const factory = _channelFactory || _defaultChannelFactory;
  const ch = factory();
  _channel = ch;
  ch.onMessage((msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    const p = _pending.get(msg.id);
    if (!p) return;
    _pending.delete(msg.id);
    if (msg.ok) p.resolve(Array.isArray(msg.vectors) ? msg.vectors : []);
    else p.reject(embedWorkerError(msg));
  });
  ch.onExit((code) => {
    // Only react to the CURRENT channel's exit — a stale handler from a
    // replaced channel must not tear down its successor.
    if (_channel !== ch) return;
    const at = Date.now();
    _crashTimes = _crashTimes.filter((t) => at - t < CRASH_WINDOW_MS);
    _crashTimes.push(at);
    if (_crashTimes.length >= MAX_CRASHES_IN_WINDOW) {
      _cooldownUntil = at + CRASH_COOLDOWN_MS;
      log.error(`embedder worker crashed ${_crashTimes.length}x in ${CRASH_WINDOW_MS / 1000}s (code=${code}); cooling down ${CRASH_COOLDOWN_MS / 1000}s`);
    } else {
      log.warn(`embedder worker exited (code=${code}); will respawn on next embed`);
    }
    _teardownChannel(new Error('embedder worker exited'));
  });
  return ch;
}

/**
 * Produce a 512-dim unit-normalised embedding for each input text. Preserves
 * input order 1:1. Throws on empty input, worker crash, or model load failure.
 */
export function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return Promise.resolve([]);
  let ch: EmbedChannel;
  try { ch = _ensureChannel(); }
  catch (err) { return Promise.reject(err as Error); }
  const id = ++_reqSeq;
  return new Promise<number[][]>((resolve, reject) => {
    _pending.set(id, {
      resolve: (vectors) => {
        if (vectors.length !== texts.length) {
          reject(new Error(`embed count mismatch: ${vectors.length} vectors vs ${texts.length} texts`));
          return;
        }
        // A clean batch resets the crash budget so a later isolated crash isn't
        // judged against ancient history.
        _crashTimes = [];
        resolve(vectors);
      },
      reject,
    });
    try {
      ch.postMessage({ id, type: 'embed', texts, batchSize: EMBED_BATCH_SIZE });
    } catch (err) {
      _pending.delete(id);
      _teardownChannel(new Error('embedder worker send failed'));
      reject(err as Error);
    }
  });
}

/** Embed a single query. Shortcut for `embedTexts([q])[0]`. */
export async function embedQuery(query: string): Promise<number[]> {
  const vs = await embedTexts([query]);
  return vs[0];
}

/** Kill the worker + reject in-flight embeds. Called on app shutdown. */
export function closeEmbedder(): void {
  _teardownChannel(new Error('embedder closed'));
}

export function _nativeEmbedLoadCodeForTests(err: unknown): string {
  return nativeEmbedLoadCode(err);
}
