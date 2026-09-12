'use strict';

const { fork, spawnSync } = require('node:child_process');

const REQUEST_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 30_000;

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

// A single lazily started stock-Node process isolates libvips from Electron's
// Linux GLib symbols. Only image bytes/options cross IPC; file access and
// publication remain at the owning feature's existing sandbox boundary.
function createSharpClient({ nodeExecutable, workerPath = __filename, timeoutMs = REQUEST_TIMEOUT_MS, idleMs = IDLE_TIMEOUT_MS, spawn = fork, onDiagnostic = () => {} }) {
  let child;
  let sequence = 0;
  let idle;
  let disposed = false;
  const pending = new Map();

  function terminate(error) {
    clearTimeout(idle);
    const previous = child;
    child = undefined;
    if (previous) previous.kill();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function scheduleIdle() {
    if (pending.size) return;
    clearTimeout(idle);
    idle = setTimeout(() => terminate(failure('E_IMAGE_RUNTIME_IDLE', 'Image worker released.')), idleMs);
    idle.unref();
  }

  function ensureChild() {
    if (disposed) throw failure('E_IMAGE_RUNTIME_CLOSED', 'Image processing has stopped.');
    if (child) return child;
    if (!nodeExecutable) throw failure('E_IMAGE_RUNTIME_MISSING', 'The bundled image runtime is missing. Prepare the app runtimes or reinstall Orkas.');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const current = spawn(workerPath, [], {
      execPath: nodeExecutable, execArgv: [], env,
      serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    child = current;
    // Pending requests have referenced deadline timers. An idle image process
    // must not keep the app/test host alive; disconnect also stops the worker.
    current.unref();
    current.channel?.unref();
    current.stdout?.unref?.();
    current.stderr?.unref?.();
    let reportedDiagnostic = false;
    const unexpectedOutput = () => {
      if (child !== current || reportedDiagnostic) return;
      reportedDiagnostic = true;
      // libvips can warn yet produce a valid image. Preserve that behavior,
      // expose a bounded diagnostic event, and never relay raw private output.
      onDiagnostic();
    };
    current.stdout.on('data', unexpectedOutput);
    current.stderr.on('data', unexpectedOutput);
    current.on('error', () => {
      if (child === current) terminate(failure('E_IMAGE_RUNTIME_START', 'Could not start the bundled image runtime. Prepare the app runtimes or reinstall Orkas.'));
    });
    current.on('exit', () => {
      if (child === current) terminate(failure('E_IMAGE_RUNTIME_EXIT', 'Image processing stopped unexpectedly. Retry the image operation.'));
    });
    current.on('message', message => {
      if (child !== current) return;
      const item = pending.get(message?.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      const result = message.result;
      const valid = item.operation === 'metadata'
        ? result && typeof result.format === 'string' && result.width > 0 && result.height > 0
        : result && Buffer.isBuffer(result.data) && result.data.length > 0 && result.info?.size === result.data.length;
      if (message.ok === true && valid) item.resolve(result);
      else item.reject(failure(message.code === 'E_IMAGE_RUNTIME_ELECTRON' ? message.code : 'E_IMAGE_PROCESS',
        message.code === 'E_IMAGE_RUNTIME_ELECTRON'
          ? 'Image processing requires the bundled Node runtime. Prepare the app runtimes and retry.'
          : 'The image could not be processed. Check the input image and requested dimensions.'));
      scheduleIdle();
    });
    return current;
  }

  return {
    request(operation, buffer, options = {}) {
      let target;
      try { target = ensureChild(); } catch (error) { return Promise.reject(error); }
      clearTimeout(idle);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) terminate(failure('E_IMAGE_RUNTIME_TIMEOUT', 'Image processing timed out. Try a smaller image or retry.'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, operation });
        try {
          target.send({ id, operation, buffer, options }, error => {
            if (error && child === target) terminate(failure('E_IMAGE_RUNTIME_SEND', 'Could not send the image for processing. Retry the image operation.'));
          });
        } catch {
          terminate(failure('E_IMAGE_RUNTIME_SEND', 'Could not send the image for processing. Retry the image operation.'));
        }
      });
    },
    close() {
      disposed = true;
      terminate(failure('E_IMAGE_RUNTIME_CLOSED', 'Image processing has stopped.'));
    },
  };
}

async function processImage(operation, buffer, options = {}) {
  if (process.versions.electron) throw failure('E_IMAGE_RUNTIME_ELECTRON', 'Stock Node is required.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw failure('E_IMAGE_PROCESS', 'Image bytes are required.');
  if (!['metadata', 'encode'].includes(operation)) throw failure('E_IMAGE_PROCESS', 'Unknown image operation.');
  const sharp = require('sharp');
  let pipeline = sharp(buffer, {
    ...(options.failOn ? { failOn: options.failOn } : {}),
    ...(options.limitInputPixels !== undefined ? { limitInputPixels: options.limitInputPixels } : {}),
    ...(options.density !== undefined ? { density: options.density } : {}),
  });
  if (operation === 'metadata') return pipeline.metadata();
  if (options.resize) pipeline = pipeline.resize(options.resize.width, options.resize.height, { fit: options.resize.fit });
  const encodeOptions = options.encodeOptions || {};
  if (options.format === 'png') pipeline = pipeline.png(encodeOptions);
  else if (options.format === 'jpeg') pipeline = pipeline.jpeg(encodeOptions);
  else if (options.format === 'webp') pipeline = pipeline.webp(encodeOptions);
  else throw failure('E_IMAGE_PROCESS', 'Unknown image output format.');
  return pipeline.toBuffer({ resolveWithObject: true });
}

// Shared by source and packaged smoke checks; never load native images in the
// caller's Electron process, including when verifying an unpacked application.
function probeImageRuntime(nodeExecutable, workerPath = __filename, spawn = spawnSync, env = process.env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  const result = spawn(nodeExecutable, [workerPath, '--probe'], {
    env: childEnv, encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 1024 * 1024, windowsHide: true,
  });
  let record;
  try { record = JSON.parse(String(result.stdout || '').trim()); } catch { /* fail closed */ }
  if (result.error || result.status !== 0 || String(result.stderr || '').trim()
    || record?.status !== 'passed' || record.sharp !== 'png-2x2' || record.electron !== null
    || !Number.isFinite(Number(record.napi)) || Number(record.napi) < 9) {
    throw failure('E_IMAGE_RUNTIME_VERIFY', 'The bundled image runtime failed verification. Run npm run native:repair in the source checkout or reinstall Orkas.');
  }
  return record;
}

if (require.main === module) {
  if (process.argv[2] === '--probe') {
    (async () => {
      const input = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#14283c"/></svg>');
      const { data } = await processImage('encode', input, { format: 'png' });
      const metadata = await processImage('metadata', data);
      if (metadata.format !== 'png' || metadata.width !== 2 || metadata.height !== 2) throw new Error('Invalid probe output');
      console.log(JSON.stringify({ status: 'passed', sharp: 'png-2x2', node: process.versions.node,
        napi: process.versions.napi, electron: process.versions.electron || null, platform: process.platform, arch: process.arch }));
    })().catch(() => { console.error('The bundled image runtime could not complete PNG encoding/decoding. Prepare the app runtimes or reinstall Orkas.'); process.exitCode = 1; });
  } else if (!process.send) process.exitCode = 1;
  else {
    process.on('disconnect', () => process.exit(0));
    process.on('message', async message => {
      if (!Number.isSafeInteger(message?.id)) return;
      try {
        const result = await processImage(message.operation, message.buffer, message.options);
        if (process.connected) process.send({ id: message.id, ok: true, result });
      } catch (error) {
        // Never return raw native errors, image contents or filesystem paths.
        if (process.connected) process.send({ id: message.id, ok: false, code: error.code });
      }
    });
  }
}

module.exports = { createSharpClient, processImage, probeImageRuntime, REQUEST_TIMEOUT_MS };
