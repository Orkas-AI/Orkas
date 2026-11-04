import { createHash } from 'node:crypto';
import { createModelEvalLogCollector } from '../../../scripts/model-eval-log-policy.mjs';

export interface RecoveredRendererRange {
  start: number; end: number; diagnosticIndex: number;
  reason?: 'expected-resource-denial' | 'expected-browser-denial' | 'expected-ipc-failure' | 'expected-renderer-failure' | 'expected-navigation-failure'; requestHash?: string; status?: number;
  messageHash?: string; channel?: string;
}

function normalizeMainLogLine(line: string): string {
  return line.replace(/^\[main:(?:stdout|stderr)\] ?/, '')
    .replace(/^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}\.\d{3})\]/, '[$1]');
}

/** Only the structured IPC emitter is eligible, with its exact channel and
 * timestamp. The owning case must first prove the rejection and recovery. */
export function invokeFailureReceipt(line: string, channel: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(channel)) throw new Error('Invalid IPC failure channel');
  const normalized = normalizeMainLogLine(line);
  const match = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[error\]\s+\[\s*\(ipc\)\] invoke ([A-Za-z][A-Za-z0-9_.]*) failed(?: |$)/.exec(normalized);
  return match?.[1] === channel ? createHash('sha256').update(normalized).digest('hex') : undefined;
}

export function navigationFailureReceipt(line: string, expectedMessage?: string): string | undefined {
  const normalized = normalizeMainLogLine(line);
  const match = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[error\]\s+\[\s*\(console\)\] (\(node:\d+\) electron: Failed to load URL: .+ with error: ERR_[A-Z_]+)$/.exec(normalized);
  return match && (expectedMessage === undefined || match[1] === expectedMessage)
    ? createHash('sha256').update(normalized).digest('hex') : undefined;
}

export interface BrowserDenialObservation {
  kind: 'cors-preflight' | 'cors-scheme' | 'csp-connect';
  url: string; origin?: string; after: number;
}

/** Explicit Chromium diagnostics for a request whose denied effects and
 * recovery have already been asserted by the owning security case. */
export function expectedBrowserDenialIndices(
  records: readonly { diagnosticIndex: number; type: string; detail?: string }[],
  request: BrowserDenialObservation,
): number[] {
  if (!request.url || /[\r\n']/.test(request.url) || !Number.isInteger(request.after) || request.after < 0
    || (request.kind !== 'csp-connect' && (!request.origin || /[\r\n']/.test(request.origin)))) {
    throw new Error('Invalid browser denial observation');
  }
  let messages: string[];
  if (request.kind === 'csp-connect') {
    messages = [
      `Connecting to '${request.url}' violates the following Content Security Policy directive: "connect-src 'self' http: https: ws: wss:". The action has been blocked.`,
      `Fetch API cannot load ${request.url}. Refused to connect because it violates the document's Content Security Policy.`,
    ];
  } else if (request.kind === 'cors-preflight' || request.kind === 'cors-scheme') {
    const reason = request.kind === 'cors-preflight'
      ? "Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource."
      : 'Cross origin requests are only supported for protocol schemes: chat-media, chrome, chrome-extension, chrome-untrusted, data, http, https.';
    messages = [
      `Access to fetch at '${request.url}' from origin '${request.origin}' has been blocked by CORS policy: ${reason}`,
      'Failed to load resource: net::ERR_FAILED',
    ];
  } else { throw new Error('Invalid browser denial kind'); }
  return messages.map(detail => {
    const matches = records.filter(record => record.diagnosticIndex >= request.after
      && record.type === 'error' && record.detail === detail);
    if (matches.length !== 1) throw new Error('Browser denial must have exactly one attributed error per message');
    return matches[0].diagnosticIndex;
  });
}

const RESOURCE_DENIED = 'Failed to load resource: the server responded with a status of 403 (Forbidden)';

/** Match browser-owned request location, never just a generic 403 message. */
export function expectedResourceDenialIndex(
  records: readonly { diagnosticIndex: number; type: string; url?: string; detail?: string }[],
  request: { url: string; after: number; status: number },
): number {
  if (request.status !== 403 || !request.url || !Number.isInteger(request.after) || request.after < 0) {
    throw new Error('Invalid resource denial observation');
  }
  const matches = records.filter(record => record.diagnosticIndex >= request.after
    && record.type === 'error' && record.url === request.url && record.detail === RESOURCE_DENIED);
  if (matches.length !== 1) throw new Error('Resource denial must have exactly one attributed browser error');
  return matches[0].diagnosticIndex;
}

/** Preserve raw logs and original severity, then classify only host-attributed
 * renderer records whose recovery has been independently verified. */
export function analyzeWebAppLogs(log: string, recovered: readonly RecoveredRendererRange[] = []) {
  const original = createModelEvalLogCollector('web-app-generation');
  const reviewed = createModelEvalLogCollector('web-app-generation');
  const lines = log.split(/\r?\n/);
  const starts = new Set<number>();
  const denials = new Set<number>();
  const browserDenials = new Set<number>();
  const rendererFailures = new Set<number>();
  const invokeLines = new Set<number>();
  const invokeFailures = new Map<string, { reason: string; expected: number; console: number; file: number }>();
  for (const range of recovered) {
    if (range.reason === 'expected-ipc-failure' || range.reason === 'expected-navigation-failure') {
      const line = lines[range.start - 1] || '';
      const hash = range.reason === 'expected-ipc-failure'
        ? range.channel && invokeFailureReceipt(line, range.channel) : navigationFailureReceipt(line);
      if (!Number.isInteger(range.start) || range.start < 1 || range.end !== range.start
        || /^\[\d{4}-\d{2}-\d{2} /.test(line)
        || !/^[a-f0-9]{64}$/.test(range.messageHash || '')
        || hash !== range.messageHash
        || invokeLines.has(range.start)) throw new Error('Invalid IPC failure receipt');
      invokeLines.add(range.start);
      const previous = invokeFailures.get(range.messageHash!);
      if (previous) {
        if (previous.reason !== range.reason) throw new Error('Invalid IPC failure receipt');
        previous.expected++;
      } else {
        invokeFailures.set(range.messageHash!, { reason: range.reason, expected: 1, console: 0, file: 0 });
      }
      continue;
    }
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < 1 || range.end < range.start || range.end > lines.length
      || !/^\[renderer:(?:error|pageerror)\] /.test(lines[range.start - 1])) {
      throw new Error('Invalid recovered renderer diagnostic range');
    }
    if (range.reason === 'expected-resource-denial') {
      if (range.start !== range.end || range.status !== 403 || !/^[a-f0-9]{64}$/.test(range.requestHash || '')
        || lines[range.start - 1] !== `[renderer:error] ${RESOURCE_DENIED}`) {
        throw new Error('Invalid expected resource denial range');
      }
      denials.add(range.start);
    }
    if (range.reason === 'expected-browser-denial') {
      const detail = lines[range.start - 1].slice('[renderer:error] '.length);
      if (range.start !== range.end || !lines[range.start - 1].startsWith('[renderer:error] ')
        || !/^[a-f0-9]{64}$/.test(range.messageHash || '')
        || createHash('sha256').update(detail).digest('hex') !== range.messageHash) {
        throw new Error('Invalid expected browser denial range');
      }
      browserDenials.add(range.start);
    }
    if (range.reason === 'expected-renderer-failure') {
      if (range.start !== range.end || !/^[a-f0-9]{64}$/.test(range.messageHash || '')
        || createHash('sha256').update(lines[range.start - 1]).digest('hex') !== range.messageHash) {
        throw new Error('Invalid expected renderer failure range');
      }
      rendererFailures.add(range.start);
    }
    starts.add(range.start);
  }
  let stream = 'stdout';
  let fileLogs = false;
  for (const [index, raw] of lines.entries()) {
    let line = raw;
    const prefix = /^\[(main|renderer):([^\]]+)\] ?/.exec(line);
    if (prefix) {
      stream = prefix[1] === 'main' && prefix[2] === 'stderr' ? 'stderr' : 'stdout';
      line = line.slice(prefix[0].length);
      if (prefix[1] === 'renderer' && ['warning', 'error', 'pageerror'].includes(prefix[2])) {
        line = `[00:00:00.000] [${prefix[2] === 'warning' ? 'warn' : 'error'}] [(renderer)] ${line}`;
      }
    }
    if (/^===/.test(line)) { stream = 'stdout'; fileLogs = true; }
    if (/^Debugger (?:listening|ending) on ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/.test(line)
      || line === 'For help, see: https://nodejs.org/learn/getting-started/debugging'
      || line === 'Waiting for the debugger to disconnect...') {
      original.ingest('stdout', '[playwright-debugger] lifecycle\n');
      reviewed.ingest('stdout', '[playwright-debugger] lifecycle\n');
      continue;
    }
    if (line.startsWith('[fixture-cleanup] ')) {
      original.ingest('stdout', line + '\n');
      reviewed.ingest('stdout', line + '\n');
      continue;
    }
    line = line.replace(/^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}\.\d{3})\]/, '[$1]');
    const invokeReceipt = invokeFailures.size && (line.includes('] invoke ') || line.includes('electron: Failed to load URL:'))
      ? invokeFailures.get(createHash('sha256').update(line).digest('hex')) : undefined;
    if (invokeReceipt) {
      if (!fileLogs && stream === 'stderr') {
        if (!invokeLines.has(index + 1)) throw new Error('Unacknowledged IPC failure log occurrence');
        invokeReceipt.console++;
      }
      else if (fileLogs && /^\[\d{4}-\d{2}-\d{2} /.test(raw)) invokeReceipt.file++;
      else throw new Error('Invalid IPC failure log source');
    }
    original.ingest(stream, line + '\n');
    reviewed.ingest(stream, (invokeReceipt
      ? `[00:00:00.000] [warn] [(${invokeReceipt.reason})] Case-verified rejection retained in the raw log`
      : starts.has(index + 1)
      ? `[00:00:00.000] [warn] [(${rendererFailures.has(index + 1) ? 'expected-renderer-failure' : browserDenials.has(index + 1) ? 'expected-browser-denial' : denials.has(index + 1) ? 'expected-resource-denial' : 'preview-recovery'})] Recovered renderer ${prefix![2]} retained at raw log line ${index + 1}`
      : line) + '\n');
  }
  for (const receipt of invokeFailures.values()) {
    if (receipt.console !== receipt.expected || receipt.file !== receipt.expected) {
      throw new Error('IPC failure requires the exact acknowledged console/file evidence count');
    }
  }
  const initial = original.finish();
  return { ...reviewed.finish(), originalLevelCounts: initial.levelCounts, originalFindings: initial.findings,
    recoveredRendererErrorCount: starts.size, expectedResourceDenialCount: denials.size,
    expectedBrowserDenialCount: browserDenials.size, expectedInvokeFailureCount: [...invokeFailures.values()].filter(value => value.reason === 'expected-ipc-failure').reduce((count, value) => count + value.expected, 0),
    expectedNavigationFailureCount: [...invokeFailures.values()].filter(value => value.reason === 'expected-navigation-failure').reduce((count, value) => count + value.expected, 0),
    expectedRendererFailureCount: rendererFailures.size,
    recoveredRendererRanges: recovered };
}
