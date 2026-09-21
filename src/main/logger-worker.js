'use strict';

// File creation, rotation and retention must never run on Electron's event loop.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const log = require('electron-log/node');

const { dateKey, sweepLogDirectory } = require('./util/log-retention');

fs.mkdirSync(workerData.directory, { recursive: true });
log.transports.file.resolvePathFn = () => path.join(workerData.directory, `${dateKey(new Date())}.log`);
log.transports.file.maxSize = workerData.fileMaxBytes;
log.transports.file.level = workerData.fileLevel;
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{scope}] {text}';
log.transports.console.level = workerData.consoleLevel;
log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] [{scope}] {text}';
// electron-log can report file errors directly to its console transport. Those
// records contain a local filename and raw exception; keep only a fixed signal.
const consoleTransport = log.transports.console;
let activeData = null;
let writeFailed = false;
const safeConsole = Object.assign(function(message) {
  if (!activeData || message.data.length !== activeData.length
      || message.data.some((value, index) => value !== activeData[index])) {
    writeFailed = true;
    return;
  }
  const stream = message.level === 'error' || message.level === 'warn' ? process.stderr : process.stdout;
  if (workerData.consoleLevel !== false && stream.writableLength < 65536) consoleTransport(message);
}, consoleTransport);
log.transports.console = safeConsole;
Object.assign(log, { processInternalErrorFn: () => { writeFailed = true; } });
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => { safeConsole.level = false; consoleTransport.level = false; });
}
try { sweepLogDirectory(workerData.directory, workerData.retainDays, workerData.totalMaxBytes); } catch (_) { /* Failure to sweep must not disable new logs. */ }

parentPort.on('message', (message) => {
  // The parent caps messages including those already sent to this port.
  // A slow disk can stall this worker without growing its mailbox indefinitely.
  activeData = message.data;
  writeFailed = false;
  try { log.processMessage(message); parentPort.postMessage({ written: !writeFailed }); }
  catch (_) { parentPort.postMessage({ written: false }); }
  finally { activeData = null; }
});
