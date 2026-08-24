'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PREVIEW_BYTES = 60_000;
const DEFAULT_READ_BYTES = 60_000;
const MAX_READ_BYTES = 60_000;
const DEFAULT_HARD_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_SETTLE_MS = 6_000;
const DEFAULT_SHUTDOWN_SETTLE_MS = 1_000;
const OUTPUT_REF_RE = /^[a-f0-9]{32}$/;

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : fallback;
}

function assertSafeScriptBase(scriptBase) {
  if (typeof scriptBase !== 'string' || !scriptBase.trim()) {
    throw new Error('script basename required');
  }
  if (scriptBase.includes('/') || scriptBase.includes('\\') || scriptBase === '.' || scriptBase === '..') {
    throw new Error('script must be a basename, not a path');
  }
}

function windowsSystem32Tool(name) {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

function killProcessTree(child, signal = 'SIGTERM', options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32' && child.pid) {
    try {
      const killer = (options.spawnFn || spawn)(
        windowsSystem32Tool('taskkill.exe'),
        ['/pid', String(child.pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true },
      );
      const fallback = () => {
        try { child.kill(signal); } catch { /* process already exited */ }
      };
      killer.once('error', fallback);
      killer.once('exit', (code) => { if (code !== 0) fallback(); });
      if (typeof killer.unref === 'function') killer.unref();
      return;
    } catch {
      // Fall through to direct child termination.
    }
  }

  try {
    if (platform !== 'win32' && child.pid) {
      (options.processKill || process.kill)(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to direct child termination.
  }
  try { child.kill(signal); } catch { /* process already exited */ }
}

class OutputSpool {
  constructor(filePath, hardLimit) {
    this.filePath = filePath;
    this.hardLimit = hardLimit;
    this.fd = fs.openSync(filePath, 'wx', 0o600);
    this.bytes = 0;
    this.sourceTruncated = false;
    this.closed = false;
  }

  append(data) {
    if (this.closed || this.sourceTruncated || !data.length) return !this.sourceTruncated;
    const remaining = Math.max(0, this.hardLimit - this.bytes);
    const accepted = data.subarray(0, Math.min(data.length, remaining));
    let offset = 0;
    while (offset < accepted.length) {
      const written = fs.writeSync(this.fd, accepted, offset, accepted.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error('Skill output spool made no write progress');
      }
      offset += written;
      this.bytes += written;
    }
    if (accepted.length < data.length) {
      this.sourceTruncated = true;
      return false;
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } catch { /* best effort */ }
  }
}

function safeUtf8PrefixLength(buffer, requestedBytes, reachesEof) {
  let end = Math.min(requestedBytes, buffer.length);
  if (reachesEof || end >= buffer.length) return end;
  let boundary = end;
  while (boundary > 0 && (buffer[boundary] & 0xc0) === 0x80) boundary--;
  return boundary < end ? boundary : end;
}

function readUtf8Chunk(filePath, offset, limit) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Skill output is unavailable');
  if (offset > stat.size) throw new Error('offset exceeds available Skill output');
  if (offset === stat.size) {
    return { offset, nextOffset: offset, bytes: stat.size, done: true, text: '' };
  }

  const requested = Math.min(limit, stat.size - offset);
  const readLength = Math.min(requested + 3, stat.size - offset);
  const buffer = Buffer.allocUnsafe(readLength);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytesRead = 0;
  try {
    while (bytesRead < readLength) {
      const count = fs.readSync(fd, buffer, bytesRead, readLength - bytesRead, offset + bytesRead);
      if (!count) break;
      bytesRead += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  const actual = buffer.subarray(0, bytesRead);
  let consumed = safeUtf8PrefixLength(actual, requested, offset + requested >= stat.size);
  if (consumed === 0 && requested > 0) consumed = requested;
  const nextOffset = offset + consumed;
  return {
    offset,
    nextOffset,
    bytes: stat.size,
    done: nextOffset >= stat.size,
    text: actual.subarray(0, consumed).toString('utf8'),
  };
}

function createBridgeSkillRunner(options) {
  if (!options || typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
    throw new Error('Skill output directory required');
  }
  if (typeof options.nodePath !== 'string' || !options.nodePath) {
    throw new Error('Skill runner Node executable required');
  }
  if (typeof options.runnerPath !== 'string' || !options.runnerPath) {
    throw new Error('Skill runner entrypoint required');
  }

  const outputDir = path.resolve(options.outputDir);
  const nodePath = options.nodePath;
  const runnerPath = path.resolve(options.runnerPath);
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const previewBytes = positiveInt(options.previewBytes, DEFAULT_PREVIEW_BYTES);
  const hardOutputBytes = Math.max(
    previewBytes,
    positiveInt(options.hardOutputBytes, DEFAULT_HARD_OUTPUT_BYTES),
  );
  const killGraceMs = positiveInt(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
  const settleMs = Math.max(
    killGraceMs + 1,
    positiveInt(options.settleMs, DEFAULT_SETTLE_MS),
  );
  const shutdownSettleMs = positiveInt(
    options.shutdownSettleMs,
    DEFAULT_SHUTDOWN_SETTLE_MS,
  );
  const activeRuns = new Set();
  let shuttingDown = false;
  let shutdownPromise = null;
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(outputDir, 0o700); } catch { /* best effort */ }
  }

  const streamPath = (outputRef, stream) => path.join(outputDir, `${outputRef}.${stream}`);

  function skillProcessEnv(skillDir) {
    const env = { ...process.env };
    // The Skill is executable third-party/user content, not part of the MCP
    // bridge trust boundary. Never hand it the run token, socket, capability
    // set, secret env-file path, or private output-spool directory. The
    // ordinary Skill sandbox variables remain available through run-skill.
    for (const key of Object.keys(env)) {
      if (key.startsWith('ORKAS_BRIDGE_')) delete env[key];
    }
    env.ORKAS_RUN_SKILL_DIR = skillDir;
    return env;
  }

  function removeOutput(outputRef) {
    for (const stream of ['stdout', 'stderr']) {
      try { fs.unlinkSync(streamPath(outputRef, stream)); } catch { /* best effort */ }
    }
  }

  function streamPreview(outputRef, stream, spool) {
    try {
      const chunk = readUtf8Chunk(streamPath(outputRef, stream), 0, previewBytes);
      return {
        text: chunk.text,
        bytes: chunk.bytes,
        truncated: !chunk.done,
        ...(spool.sourceTruncated ? { sourceTruncated: true } : {}),
        ...(!chunk.done ? { nextOffset: chunk.nextOffset } : {}),
      };
    } catch {
      // The host owns the run-scoped output directory and may remove it while
      // a socket-close shutdown is settling. Treat that race as capture loss,
      // never as an uncaught MCP bridge failure.
      return {
        text: '',
        bytes: spool.bytes,
        truncated: false,
        ...(spool.sourceTruncated ? { sourceTruncated: true } : {}),
        unavailable: true,
      };
    }
  }

  function run({ skillRef, scriptBase, args = [], skillDir }) {
    if (shuttingDown) throw new Error('Skill runner is shutting down');
    assertSafeScriptBase(scriptBase);
    const outputRef = crypto.randomBytes(16).toString('hex');
    const stdoutSpool = new OutputSpool(streamPath(outputRef, 'stdout'), hardOutputBytes);
    const stderrSpool = new OutputSpool(streamPath(outputRef, 'stderr'), hardOutputBytes);
    const startedAt = Date.now();

    let settled = false;
    let activeEntry = null;
    let abortRun = () => {};
    const completion = new Promise((resolve) => {
      let child;
      let timedOut = false;
      let aborted = false;
      let outputLimitExceeded = false;
      let captureFailed = false;
      let killStarted = false;
      let timeoutTimer = null;
      let forceKillTimer = null;
      let settleTimer = null;

      const clearTimers = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (settleTimer) clearTimeout(settleTimer);
      };

      const startTermination = () => {
        if (killStarted || !child) return;
        killStarted = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        killProcessTree(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), killGraceMs);
        settleTimer = setTimeout(() => finish(null, null), settleMs);
        if (typeof forceKillTimer.unref === 'function') forceKillTimer.unref();
        if (typeof settleTimer.unref === 'function') settleTimer.unref();
      };

      const append = (spool, data) => {
        if (settled || outputLimitExceeded || captureFailed) return;
        try {
          if (!spool.append(data)) {
            outputLimitExceeded = true;
            startTermination();
          }
        } catch {
          spool.sourceTruncated = true;
          captureFailed = true;
          startTermination();
        }
      };

      const finish = (code, signal, startError) => {
        if (settled) return;
        settled = true;
        if (activeEntry) activeRuns.delete(activeEntry);
        clearTimers();
        try { child?.stdout?.destroy(); } catch { /* best effort */ }
        try { child?.stderr?.destroy(); } catch { /* best effort */ }
        if (startError) {
          try { stderrSpool.append(Buffer.from(`Failed to start Skill script: ${startError.code || 'process error'}\n`)); }
          catch { captureFailed = true; }
        }
        stdoutSpool.close();
        stderrSpool.close();

        const stdout = streamPreview(outputRef, 'stdout', stdoutSpool);
        const stderr = streamPreview(outputRef, 'stderr', stderrSpool);
        if (!aborted && (stdout.unavailable || stderr.unavailable)) captureFailed = true;
        const hasContinuation = stdout.truncated || stderr.truncated;
        if (!hasContinuation) removeOutput(outputRef);
        const status = startError
          ? 'start_failed'
          : timedOut
            ? 'timed_out'
            : aborted
              ? 'aborted'
              : outputLimitExceeded || captureFailed
                ? 'output_limit'
                : code === 0
                  ? 'succeeded'
                  : 'failed';
        resolve({
          status,
          exitCode: Number.isInteger(code) ? code : null,
          signal: typeof signal === 'string' ? signal : null,
          durationMs: Date.now() - startedAt,
          timedOut,
          outputLimitExceeded: outputLimitExceeded || captureFailed,
          stdout,
          stderr,
          ...(hasContinuation ? { outputRef } : {}),
        });
      };

      const abortImmediately = () => {
        if (settled) return;
        aborted = true;
        killStarted = true;
        clearTimers();
        if (!child) {
          finish(null, null);
          return;
        }
        killProcessTree(child, 'SIGKILL');
        settleTimer = setTimeout(() => finish(null, 'SIGKILL'), shutdownSettleMs);
        if (typeof settleTimer.unref === 'function') settleTimer.unref();
      };
      abortRun = abortImmediately;

      try {
        child = spawn(nodePath, [runnerPath, skillRef, scriptBase, '--', ...args], {
          env: skillProcessEnv(skillDir),
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        finish(null, null, error);
        return;
      }

      child.stdout.on('data', (data) => append(stdoutSpool, data));
      child.stderr.on('data', (data) => append(stderrSpool, data));
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        startTermination();
      }, timeoutMs);
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    });
    activeEntry = { terminate: () => abortRun(), completion };
    if (!settled) activeRuns.add(activeEntry);
    return completion;
  }

  function read({ outputRef, stream, offset = 0, limit = DEFAULT_READ_BYTES }) {
    if (typeof outputRef !== 'string' || !OUTPUT_REF_RE.test(outputRef)) {
      throw new Error('valid output_ref required');
    }
    if (stream !== 'stdout' && stream !== 'stderr') {
      throw new Error('stream must be stdout or stderr');
    }
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_BYTES) {
      throw new Error(`limit must be an integer from 1 to ${MAX_READ_BYTES}`);
    }
    const filePath = streamPath(outputRef, stream);
    if (!fs.existsSync(filePath)) throw new Error('Skill output reference is unavailable or expired');
    const chunk = readUtf8Chunk(filePath, offset, limit);
    return {
      outputRef,
      stream,
      ...chunk,
    };
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    const pending = Array.from(activeRuns);
    for (const entry of pending) entry.terminate();
    shutdownPromise = Promise.allSettled(pending.map((entry) => entry.completion)).then(() => {});
    return shutdownPromise;
  }

  return { run, read, removeOutput, shutdown };
}

module.exports = {
  DEFAULT_HARD_OUTPUT_BYTES,
  DEFAULT_PREVIEW_BYTES,
  DEFAULT_READ_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_READ_BYTES,
  createBridgeSkillRunner,
  killProcessTree,
};
