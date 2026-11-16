'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { errorMonitor } = require('node:events');
const { createModelEvalLogCollector } = require('../../../scripts/model-eval-log-policy.mjs');

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_PROCESSES = 128;
const MAX_CASE_BYTES = 64 * 1024 * 1024;
let active = null;

function codeOf(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'unknown';
}

function note(scope, code) {
  scope.issueCounts[code] = (scope.issueCounts[code] || 0) + 1;
}

// Raw streams stay local evidence. Published metadata contains only counts,
// diagnostic codes and source hashes, never arbitrary stdout fields or paths.
function summarize(analysis) {
  const findings = analysis.findings.slice(0, 100).map(finding => ({
    severity: finding.severity, code: finding.code, count: finding.count,
    source: ['stderr', 'node', 'python-http-preview', 'firefox-native-browser', 'webkit-native-browser', 'chromium-headless-browser'].includes(finding.source) ? finding.source : 'runtime-source',
    sourceHash: crypto.createHash('sha256').update(finding.source || '').digest('hex').slice(0, 16),
  }));
  const omittedFindingCount = analysis.findings.length - findings.length;
  const select = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key] || 0]));
  return { phase: analysis.phase, passed: analysis.passed && !omittedFindingCount,
    requiresReview: analysis.requiresReview || !!omittedFindingCount,
    coveragePassed: analysis.coveragePassed && !omittedFindingCount,
    capturedBytes: analysis.capturedBytes, capturedLineCount: analysis.capturedLineCount,
    analyzedLineCount: analysis.analyzedLineCount, blankLineCount: analysis.blankLineCount,
    droppedBytes: analysis.droppedBytes, droppedLineCount: analysis.droppedLineCount,
    classificationCounts: select(analysis.classificationCounts, ['runtime', 'processWarning', 'processError', 'control', 'other']),
    levelCounts: select(analysis.levelCounts, ['debug', 'info', 'warn', 'error']),
    streamLineCounts: select(analysis.streamLineCounts, ['stdout', 'stderr']),
    reportedPathCount: analysis.reportPaths?.length || 0, omittedFindingCount, findings };
}

function capture(scope, child) {
  if (scope.records.length >= MAX_PROCESSES) { note(scope, 'process_limit'); return; }
  const record = { index: scope.records.length + 1, pid: child.pid ?? null,
    startedAt: new Date().toISOString(), closed: false, exitCode: null, signal: null,
    producer: undefined, expectedSignals: [], streams: {}, issues: {} };
  scope.records.push(record);
  scope.children.set(child, record);
  for (const stream of ['stdout', 'stderr']) {
    const name = `native-process-${record.index}-${stream}.log`;
    const state = { name, available: !!child[stream], owned: false, rawByteExact: true, bytes: 0, storedBytes: 0, droppedBytes: 0,
      hash: crypto.createHash('sha256'), fd: null };
    record.streams[stream] = state;
    if (!state.available) { record.issues[stream + '_unavailable'] = 1; continue; }
    try { state.fd = fs.openSync(path.join(scope.directory, name), 'wx', 0o600); state.owned = true; }
    catch (error) { record.issues[stream + '_open_' + codeOf(error)] = 1; }
    state.onData = chunk => {
      if (!Buffer.isBuffer(chunk)) {
        state.rawByteExact = false;
        record.issues[stream + '_decoded_before_raw_capture'] = 1;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      state.bytes += bytes.length;
      state.hash.update(bytes);
      const retained = Math.min(bytes.length, Math.max(0, scope.maxStreamBytes - state.storedBytes), Math.max(0, scope.maxCaseBytes - scope.storedBytes));
      let written = 0;
      if (state.fd !== null) {
        try {
          while (written < retained) {
            const count = fs.writeSync(state.fd, bytes, written, retained - written);
            if (!count) throw Object.assign(new Error('Capture write made no progress'), { code: 'EIO' });
            written += count;
          }
        } catch (error) { record.issues[stream + '_write_' + codeOf(error)] = 1; }
      }
      state.storedBytes += written;
      scope.storedBytes += written;
      state.droppedBytes += bytes.length - written;
    };
    child[stream].on('data', state.onData);
  }
  record.close = new Promise(resolve => {
    child.once(errorMonitor, error => { record.issues['child_' + codeOf(error)] = 1; });
    child.once('close', (code, signal) => {
      record.closed = true;
      record.exitCode = code;
      record.signal = signal;
      record.closedAt = new Date().toISOString();
      for (const state of Object.values(record.streams)) {
        if (state.fd !== null) {
          try { fs.closeSync(state.fd); } catch (error) { record.issues['close_' + codeOf(error)] = 1; }
          state.fd = null;
        }
        if (!state.sha256) state.sha256 = state.hash.digest('hex');
      }
      resolve();
    });
  });
}

// Preserve the caller's browser, options and launch result. The single new
// direct child proves ownership before applying its native browser log format.
async function launchAuditedBrowser(browserType, options, name) {
  const scope = active;
  const display = name === 'firefox' ? 'Firefox' : name === 'webkit' ? 'WebKit' : 'Chromium';
  if (!scope || browserType.name() !== name || name === 'chromium' && options?.headless !== true) throw new Error(`Audited ${display} launch requires its owning native scope and launch mode`);
  const before = scope.records.length;
  const browser = await Reflect.apply(browserType.launch, browserType, [options]);
  if (active !== scope || scope.records.length !== before + 1) note(scope, name + '_process_ownership');
  else scope.records[before].producer = name === 'chromium' ? 'chromium-headless-browser' : name + '-native-browser';
  return browser;
}
const launchAuditedFirefox = (browserType, options) => launchAuditedBrowser(browserType, options, 'firefox');
const launchAuditedWebKit = (browserType, options) => launchAuditedBrowser(browserType, options, 'webkit');
const launchAuditedChromium = (browserType, options) => launchAuditedBrowser(browserType, options, 'chromium');

function recordFor(child) {
  const record = active?.children.get(child);
  if (!record || record.closed) throw new Error('Native log acknowledgement requires a live owned process');
  return record;
}

function tagNativeProcess(child, producer) {
  if (producer !== 'python-http-preview') throw new Error('Unsupported native log producer');
  recordFor(child).producer = producer;
}

function expectNativeProcessTermination(child, signal) {
  if (signal !== 'SIGTERM') throw new Error('Only the explicit fixture SIGTERM shutdown is supported');
  recordFor(child).expectedSignals.push(signal);
}

// A case calls this only after asserting the exact injected Error and its
// recovery/privacy outcome. Native severity and raw bytes remain in the report.
function acknowledgeNativeConsoleError({ message, sourceURL } = {}) {
  if (!active) throw new Error('Native console acknowledgement requires an active test scope');
  if (typeof message !== 'string' || !message || message.length > 512 || /["\r\n]/.test(message)
    || typeof sourceURL !== 'string' || sourceURL.length > 2048 || /["\r\n]/.test(sourceURL))
    throw new Error('Invalid exact native console error observation');
  let url;
  try { url = new URL(sourceURL); } catch { throw new Error('Invalid native console source'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash)
    throw new Error('Native console observation requires an owned loopback source');
  if (active.consoleErrors.length >= 16 || active.consoleErrors.some(item => item.message === message && item.sourceURL === sourceURL))
    throw new Error('Duplicate or excessive native console acknowledgement');
  active.consoleErrors.push({ message, sourceURL, matches: [] });
}

// The owning 404 journey first verifies status, body privacy and recovery.
// Bind its one expected HTTP record to the actual tagged preview process.
function acknowledgeNativePreviewNotFound(child, { method, target } = {}) {
  const record = recordFor(child);
  if (record.producer !== 'python-http-preview') throw new Error('Expected response requires an owned Python preview');
  if (!['GET', 'HEAD'].includes(method) || typeof target !== 'string' || !target.startsWith('/')
    || target.length > 8192 || /["\r\n]/.test(target)) throw new Error('Invalid exact preview response observation');
  if (active.previewNotFound.length >= 16 || active.previewNotFound.some(item => item.process === record.index && item.method === method && item.target === target))
    throw new Error('Duplicate or excessive preview response acknowledgement');
  active.previewNotFound.push({ process: record.index, method, target, matches: [] });
}

function beginNativeProcessAudit(directory, { maxStreamBytes = MAX_STREAM_BYTES, maxCaseBytes = MAX_CASE_BYTES } = {}) {
  if (active) throw new Error('Native process log scopes cannot overlap in one test worker');
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 1 || maxStreamBytes > MAX_STREAM_BYTES)
    throw new Error('Invalid native process log capture limit');
  if (!Number.isSafeInteger(maxCaseBytes) || maxCaseBytes < 1 || maxCaseBytes > MAX_CASE_BYTES)
    throw new Error('Invalid native process log case limit');
  const scope = { directory: path.resolve(directory), maxStreamBytes, maxCaseBytes, storedBytes: 0, records: [], children: new Map(), issueCounts: {}, consoleErrors: [], previewNotFound: [] };
  fs.mkdirSync(scope.directory, { recursive: true });
  const previousSpawn = childProcess.spawn;
  const capturedSpawn = function (...args) {
    let child;
    try { child = Reflect.apply(previousSpawn, this, args); }
    catch (error) { if (active === scope) note(scope, 'spawn_' + codeOf(error)); throw error; }
    if (active === scope) {
      try { capture(scope, child); }
      catch (error) { note(scope, 'observer_' + codeOf(error)); }
    }
    return child;
  };
  childProcess.spawn = capturedSpawn;
  syncBuiltinESMExports();
  active = scope;
  let finishing;
  return { finish({ waitMs = 5000 } = {}) {
    if (finishing) return finishing;
    finishing = (async () => {
      let timer;
      try {
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5000)
          throw new Error('Invalid native process log completion wait');
        await Promise.race([Promise.all(scope.records.map(record => record.close)),
          new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
        if (!scope.records.length) note(scope, 'no_process_captured');
        const expectedLines = new Map();
        if (scope.consoleErrors.length || scope.previewNotFound.length) {
          for (const record of scope.records) {
            const state = record.streams.stderr;
            if (!record.closed || !state?.owned || state.bytes !== state.storedBytes) continue;
            const lines = fs.readFileSync(path.join(scope.directory, state.name), 'utf8').split(/\r?\n/);
            for (const [index, line] of lines.entries()) {
              // Keep the existing millisecond precision and the observed microsecond
              // precision in the exact Chromium wire format, source and message;
              // a matching payload in arbitrary stderr/stdout is insufficient.
              const match = /^\[\d{4}\/\d{6}\.\d{3}(?:\d{3})?:INFO:CONSOLE:(\d+)\] "Uncaught Error: ([^"\r\n]+)", source: ([^\r\n]+) \((\d+)\)$/.exec(line);
              const expected = match && match[1] === match[4]
                && scope.consoleErrors.find(item => item.message === match[2] && item.sourceURL === match[3]);
              const preview = record.producer === 'python-http-preview'
                && /^127\.0\.0\.1 - - \[[^\]\r\n]{1,80}\] "(GET|HEAD) ([^"\r\n]{1,8192}) HTTP\/1\.[01]" 404 (?:-|[0-9]+)$/.exec(line);
              const response = preview && scope.previewNotFound.find(item => item.process === record.index && item.method === preview[1] && item.target === preview[2]);
              if (expected || response) (expected || response).matches.push({ process: record.index, line: index + 1,
                sha256: crypto.createHash('sha256').update(line).digest('hex') });
            }
          }
          for (const expected of [...scope.consoleErrors, ...scope.previewNotFound]) {
            if (expected.matches.length !== 1) { note(scope, scope.consoleErrors.includes(expected) ? 'unmet_native_console_error' : 'unmet_preview_response'); continue; }
            const match = expected.matches[0];
            if (!expectedLines.has(match.process)) expectedLines.set(match.process, new Set());
            expectedLines.get(match.process).add(match.line);
          }
        }
        const records = [];
        for (const record of scope.records) {
          if (!record.closed) {
            for (const [stream, state] of Object.entries(record.streams)) {
              const child = [...scope.children].find(([, value]) => value === record)?.[0];
              if (child && state.onData) child[stream]?.removeListener('data', state.onData);
              if (state.fd !== null) {
                try { fs.closeSync(state.fd); } catch (error) { record.issues['freeze_' + codeOf(error)] = 1; }
                state.fd = null;
              }
              if (!state.sha256) state.sha256 = state.hash.digest('hex');
            }
          }
          const streams = {};
          for (const [stream, state] of Object.entries(record.streams)) {
            let analysis = null;
            if (record.closed && state.available && state.owned && state.storedBytes === state.bytes) {
              const raw = fs.readFileSync(path.join(scope.directory, state.name));
              if (raw.length !== state.bytes || crypto.createHash('sha256').update(raw).digest('hex') !== state.sha256)
                record.issues[stream + '_file_mismatch'] = 1;
              const collector = createModelEvalLogCollector(`native-process-${record.index}-${stream}`, { producer: record.producer });
              collector.ingest(stream, raw);
              const original = collector.finish();
              analysis = summarize(original);
              const acknowledged = stream === 'stderr' && expectedLines.get(record.index);
              if (acknowledged?.size) {
                const reviewed = createModelEvalLogCollector(`native-process-${record.index}-${stream}`, { producer: record.producer });
                for (const [index, chunk] of raw.toString('utf8').split(/(?<=\n)/).entries())
                  reviewed.ingest(stream, acknowledged.has(index + 1)
                    ? `[00:00:00.000] [warn] [(expected-native-diagnostic)] Case-verified error retained at raw line ${index + 1}${chunk.endsWith('\n') ? '\n' : ''}` : chunk);
                analysis = { ...summarize(reviewed.finish()), originalAnalysis: summarize(original), expectedConsoleErrorCount: scope.consoleErrors.filter(item => item.matches.length === 1 && item.matches[0].process === record.index).length, expectedPreviewNotFoundCount: scope.previewNotFound.filter(item => item.matches.length === 1 && item.matches[0].process === record.index).length };
              }
            }
            streams[stream] = { file: state.name, available: state.available, owned: state.owned, rawByteExact: state.rawByteExact, bytes: state.bytes,
              storedBytes: state.storedBytes, droppedBytes: state.droppedBytes, sha256: state.sha256 ?? null, analysis };
          }
          const complete = record.closed && !Object.keys(record.issues).length
            && Object.values(streams).every(s => s.available && s.owned && s.bytes === s.storedBytes && !s.droppedBytes && s.analysis?.coveragePassed);
          const expectedTermination = record.closed && record.signal !== null && record.expectedSignals.includes(record.signal);
          const exitAccepted = record.closed && ((record.exitCode === 0 && record.signal === null) || expectedTermination);
          records.push({ index: record.index, pid: record.pid, startedAt: record.startedAt,
            closedAt: record.closedAt ?? null, closed: record.closed, complete,
            exitCode: record.exitCode, signal: record.signal, expectedSignals: record.expectedSignals,
            expectedTermination, exitAccepted, producer: record.producer ?? null, issues: record.issues, streams });
        }
        const complete = !Object.keys(scope.issueCounts).length && records.every(record => record.complete);
        const passed = complete && records.every(record => record.exitAccepted && Object.values(record.streams).every(stream => stream.analysis?.passed));
        const report = { kind: 'native-process-stdio-audit', version: 1, complete, passed,
          maxStreamBytes, maxCaseBytes, maxProcesses: MAX_PROCESSES, issueCounts: scope.issueCounts,
          expectedConsoleErrors: scope.consoleErrors.map(item => ({
            messageHash: crypto.createHash('sha256').update(item.message).digest('hex'),
            sourceHash: crypto.createHash('sha256').update(item.sourceURL).digest('hex'),
            expectedCount: 1, actualCount: item.matches.length, matches: item.matches })),
          expectedPreviewNotFound: scope.previewNotFound.map(item => ({ process: item.process, method: item.method,
            targetHash: crypto.createHash('sha256').update(item.target).digest('hex'),
            expectedCount: 1, actualCount: item.matches.length, matches: item.matches })),
          captureBoundary: 'Direct processes launched in this test worker from the original public spawn return, before Playwright attaches its stream consumers. Original child identity, arguments, stdio and consumers are unchanged. Captured native descendant output is limited to inherited stdout/stderr handles.', processes: records };
        const file = path.join(scope.directory, 'native-process-audit.json');
        fs.writeFileSync(file, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
        return { report, file, streamFiles: records.flatMap(record => Object.values(record.streams).filter(stream => stream.owned).map(stream => path.join(scope.directory, stream.file))) };
      } finally {
        if (timer) clearTimeout(timer);
        active = null;
        if (childProcess.spawn === capturedSpawn) { childProcess.spawn = previousSpawn; syncBuiltinESMExports(); }
      }
    })();
    return finishing;
  } };
}

module.exports = { beginNativeProcessAudit, tagNativeProcess, expectNativeProcessTermination, acknowledgeNativeConsoleError, launchAuditedFirefox, launchAuditedWebKit, launchAuditedChromium, acknowledgeNativePreviewNotFound };
