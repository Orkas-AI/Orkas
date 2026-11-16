import fs from "node:fs";
import path from "node:path";

const RUNTIME_LOG_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[(debug|info|warn|error)\]\s+\[\s*\(([^)]*)\)\s*\]\s*(.*)$/i;
// Exact utils/log.py Loguru envelope. Request IDs are framing only and never
// become report sources or finding dimensions. SGR colors can split chunks;
// normalize only after the bounded line buffer has assembled a complete line.
const SERVER_RUNTIME_LOG_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[(TRACE|DEBUG|INFO|SUCCESS|WARNING|ERROR|CRITICAL)\]\[rid=[^\]\r\n]{1,128}\]\s*(.*)$/;
const SERVER_LOG_LEVELS = { TRACE: 'debug', DEBUG: 'debug', INFO: 'info', SUCCESS: 'info',
  WARNING: 'warn', ERROR: 'error', CRITICAL: 'error' };
const CASE_MARKER_RE = /^\[model-eval-case\]\s+(start|end)\s+(.+)$/;
const CASE_LOG_RE = /^\[model-eval-case-log ([A-Za-z0-9_./:-]{1,240})\] (.*)$/;
const REPORT_RE = /^report=(.+)$/;
// Chromium may include its thread ID after the process ID; the emitter,
// task policy and exact nonfatal OS status remain the same as Electron's.
export const ELECTRON_MACOS_TASK_POLICY_WARNING_RE = /^\[\d+(?::\d+)?:\d{4}\/\d{6}\.\d+:ERROR:base\/process\/process_mac\.cc:\d+\]\s+task_policy_set\s+TASK_(?:CATEGORY|SUPPRESSION)_POLICY:\s+\(os\/kern\)\s+invalid argument\s+\(4\)$/;
const ELECTRON_MACOS_SPELLCHECKER_WARNING_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ Electron\[\d+:\d+\] NSSpellServer dataFromCheckingString (?:timed out|succeeded), index is \d+$/;
// Chromium returns from duplicate allocator registration and uses a timer when
// macOS DisplayLink is unavailable. These exact native diagnostics are warnings
// only for a launch-owned headless Chromium process; errors/exits still fail.
// https://chromium.googlesource.com/chromium/src/+/cf3d9f331459d507aca238c9546fa3da1cd7abd9
// https://chromium.googlesource.com/chromium/src/base/+/bfda68cdadd3a7e12de6c531598d545a467a8c80%5E%21/
const CHROMIUM_MACOS_HEADLESS_WARNINGS = [
  /^Trying to load the allocator multiple times\. This is \*not\* supported\.$/,
  /^\[(?:\d+:\d+:)?\d{4}\/\d{6}\.\d{3,6}:ERROR:ui\/display\/mac\/cv_display_link_mac\.mm:\d+\] CVDisplayLinkCreateWithCGDisplay failed\. CVReturn: -6670$/,
  /^\[(?:\d+:)?\d{4}\/\d{6}\.\d{3,6}:ERROR:sandbox\/mac\/system_services\.cc:\d+\] SetApplicationIsDaemon: Error Domain=NSOSStatusErrorDomain Code=-50 "paramErr: error in user parameter list" \(-50\)$/,
];
// Playwright 1.61.1's Helper.js:82 is the teardown callback returned by
// addProgressListener, not a page operation. Keep this exact automation-only
// cleanup failure reviewable; all other Firefox errors and process exits fail.
// https://github.com/microsoft/playwright/blob/v1.61.1/browser_patches/firefox/juggler/Helper.js#L80-L88
const FIREFOX_JUGGLER_PROGRESS_CLEANUP_WARNING = 'JavaScript error: chrome://juggler/content/Helper.js, line 82: NS_ERROR_FAILURE: Component returned failure code: 0x80004005 (NS_ERROR_FAILURE) [nsIWebProgress.removeProgressListener]';
// RKV emits this explicitly leveled WARN envelope from its safe backend.
// Preserve it for review only inside the launch-owned Firefox stderr stream.
// https://github.com/mozilla/rkv/blob/main/src/backend/impl_safe/environment.rs#L339-L341
const FIREFOX_RKV_WARNING_RE = /^\[WARN[ \t]+rkv::backend::impl_safe::environment\][ \t]+\S/;
// This native macOS VM-query diagnostic can omit its newline during video
// playback. Recognize only the exact query/status; parse any appended record
// independently so an unknown diagnostic or Firefox error remains fatal.
// https://github.com/cypress-io/cypress/issues/32070
const MACOS_HYPERVISOR_QUERY_WARNING = 'sysctlbyname for kern.hv_vmm_present failed with status -1';
/** The one runtime warning whose message can span several lines: AgentRunner
 *  splices a slice of the failed tool's result, newlines included. */
const TOOL_ERROR_PAYLOAD_RE = /\bTool\s+\S+\s+returned error:/i;
// Node-only toolFailureForLog records contain bounded correlation and parser
// facts. Admit their known shapes; arbitrary indented stderr still fails.
const NODE_TOOL_DIAGNOSTIC_SCALAR_RE = /^  (?:tool: '[A-Za-z0-9_-]+'|runner_ref: '[a-f0-9]{24}'|batch_sequence: \d+|execution_mode: '(?:single|parallel|programmatic)'|(?:session_hash|call_hash|command_hash|output_ref_hash): '[a-f0-9]{12}'|input_digest: 'sha256:[a-f0-9]{64}'|result: \{ text_hash: '[a-f0-9]{12}', text_chars: \d+ \}|output_storage: '(?:inline|persisted)'),?$/;
const NODE_TOOL_INPUT_DIAGNOSTIC_RE = /^    (?:stream_json: '(?:strict|non_strict|unobserved|limit)'|tolerant_parse: '(?:used|not_used|unknown)'|parsed_input_matches: (?:true|false)),?$/;
// Exact ordered metadata emitted by tools/base.ts's native console logger.
const NODE_TOOL_BUDGET_LINES = [
  /^  tool: '[A-Za-z0-9_-]+',$/,
  /^  field: '(?:tool description|schema description at \/inputSchema(?:\/[^'\r\n]*)?)',$/,
  /^  estimatedTokens: \d+,$/,
  /^  softBudgetTokens: \d+$/,
  /^}$/,
];

// Exact console.warn record from AgentRunner; this is retry metadata, never
// evidence that a request recovered. Free-form provider messages stay fatal.
function isNativeProviderRetry(line) {
  const match = /^\[agent-runner\] retrying provider request \{ kind: '(?:rate_limit|timeout|connection_dropped|service_unavailable|server_error|network)', attempt: (\d{1,16}), maxRetries: (\d{1,16}), waitMs: (\d{1,16}) \}$/.exec(line);
  if (!match) return false;
  const [attempt, maximum, wait] = match.slice(1).map(Number);
  return [attempt, maximum, wait].every(Number.isSafeInteger)
    && attempt > 0 && attempt <= maximum;
}
const NATIVE_PROVIDER_RETRY_LINES = [
  /^  kind: '(?:rate_limit|timeout|connection_dropped|service_unavailable|server_error|network)',$/,
  /^  attempt: \d{1,16},$/,
  /^  maxRetries: \d{1,16},$/,
  /^  waitMs: \d{1,16}$/,
  /^}$/,
];

const STDERR_CONTEXT_CONTINUATION_RE = /^(?:\s+|\[\d+\]\s|[}\]]|\(Use\s|<\/?[a-z][\w:.-]*(?:\s[^>]*)?>?\s*$)/i;

/** A partial line held per stream until its newline arrives. A child printing
 * one unbounded line must not grow the coordinator; the remainder is counted
 * as a captured but never analyzed line so the coverage gate fails. */
const MAX_PARTIAL_LINE_CHARS = 8 * 1024 * 1024;
const INSPECTOR_ID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const LOCAL_INSPECTOR_RECORD_RE = new RegExp(`^(?:Debugger (?:listening|ending) on ws://127\\.0\\.0\\.1:\\d+/${INSPECTOR_ID}|DevTools listening on ws://127\\.0\\.0\\.1:\\d+/devtools/browser/${INSPECTOR_ID})$`);
const PYTHON_PREVIEW_ACCESS_RE = /^127\.0\.0\.1 - - \[[^\]\r\n]{1,80}\] "(?:GET|HEAD) [^"\r\n]{1,8192} HTTP\/1\.[01]" [23]\d\d (?:-|[0-9]+)$/;
const PYTHON_PREVIEW_REBUILD_RE = /^127\.0\.0\.1 - - \[[^\]\r\n]{1,80}\] rebuilt localized preview \/[^\s\r\n]{0,8192}\?lang=[a-z]{2}(?:-[a-z0-9]{2,3})?$/;
// WebKit's MediaSessionManagerInterface release logs and typed dump rows.
// Only a launch-bound WebKit producer may use this non-error native format.
const WEBKIT_MEDIA_RECORD_RE = /^\[WebKitWin:Media:-\] MediaSessionManagerInterface::(?:sessionWillBeginPlayback\(0\) \d{1,20}(?: returning (?:true|false))?|setCurrentSession\(0\) \d{1,20}, size = \d{1,10}|dumpSessionStates\(0\)  Sessions:)$/;
const WEBKIT_MEDIA_DUMP_RE = /^\[WebKitWin:Media:-\] MediaSessionManagerInterface::dumpSessionStates\(0\)  Sessions:$/;
const WEBKIT_MEDIA_SESSION_RE = /^\([a-fA-F0-9]{1,16}\): (?:(?:None|Video|VideoAudio|Audio|WebAudio|DOMMediaSession), (?:Idle|Autoplaying|Playing|Paused|Interrupted)(?:, [^\x00-\x1f\x7f]{0,1024})?|null)$/;

/** Exact progress records emitted by bin/ensure-runtime.cjs, not evidence that
 * dependency preparation succeeded; the launcher still checks its exit status. */
function isRuntimePreparationProgress(line) {
  const record = /^runtime (?:python|uv|node)(: downloading| self-check ok) (\{.*\})$/.exec(line);
  if (!record) return false;
  try {
    const metadata = JSON.parse(record[2]);
    const fields = record[1] === ": downloading" ? ["key", "asset"] : ["version"];
    return Object.keys(metadata).length === fields.length
      && fields.every((field) => typeof metadata[field] === "string");
  } catch {
    return false;
  }
}

function findingDetail(code) {
  switch (code) {
    case "tool-definition-soft-budget":
      return "one or more tool definitions exceeded the configured soft description budget";
    case "node-deprecation-warning":
      return "the evaluation process used a deprecated Node.js API";
    case "node-runtime-warning":
      return "the evaluation process emitted a Node.js runtime warning";
    case "runtime-warning":
      return "the production runtime emitted a warning that requires review";
    case "runtime-error":
      return "the production runtime emitted an error-level log";
    case "firefox-runtime-error":
      return "the owned Firefox browser emitted a native error-level diagnostic";
    case "firefox-runtime-warning":
      return "the owned Firefox browser emitted a native warning requiring review";
    case "firefox-juggler-cleanup-warning":
      return "Playwright's Firefox automation listener cleanup failed; native bytes and exit acceptance are retained for review";
    case "tool-execution-failed":
      return "a tool failed; inspect its structured call outcome and recovery without erasing the failure";
    case "provider-request-failed":
      return "the native provider reported a failed request; preserve the failure and inspect its diagnostic record";
    case "provider-request-retry":
      return "the native runner retried a provider request; this does not establish recovery";
    case "plain-process-warning":
      return "a non-structured process warning requires review";
    case "electron-runner-failure":
      return "the Electron model-evaluation runner failed before normal completion";
    case "electron-runner-signaled":
      return "the Electron model-evaluation runner was terminated by an operating-system signal";
    case "electron-macos-task-policy-warning":
      return "Chromium could not apply a non-critical macOS task policy to a child process";
    case "chromium-macos-headless-warning":
      return "owned headless Chromium reported a macOS allocator, display-clock fallback or LaunchServices warning; native bytes and exit acceptance are retained";
    case "electron-macos-spellchecker-warning":
      return "the macOS spellchecking service reported a timeout or recovery requiring review";
    case "unclassified-stderr":
      return "unclassified stderr is treated as a process error until explicitly classified";
    case "log-coverage-gap":
      return "not every captured non-empty process-log line was analyzed";
    case "preflight-failure":
      return "the strict model-evaluation case audit failed";
    case "environment-preflight-failure":
      return "the normal product dependency preparation failed before evaluation dispatch";
    case "launcher-failure":
      return "the model-evaluation launcher could not start a required child process";
    default:
      return "the model-evaluation process emitted a classified diagnostic";
  }
}

function findingKey(finding) {
  return [
    finding.severity,
    finding.code,
    finding.phase,
    finding.source || "",
    finding.caseKey || "",
    finding.attribution || "",
  ].join("\0");
}

function aggregateFindings(findings) {
  const aggregated = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const current = aggregated.get(key);
    if (current) {
      current.count += finding.count;
    } else {
      aggregated.set(key, { ...finding });
    }
  }
  return [...aggregated.values()].sort((left, right) => (
    `${left.severity}/${left.phase}/${left.caseKey || ""}/${left.code}`
      .localeCompare(`${right.severity}/${right.phase}/${right.caseKey || ""}/${right.code}`)
  ));
}

export function normalizePytestLogFrame(line) {
  // pytest-subtests writes its successful-subtest progress without a newline.
  // Strip that protocol fragment only before a complete Server log envelope.
  return line.replace(/^u+(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[(?:TRACE|DEBUG|INFO|SUCCESS|WARNING|ERROR|CRITICAL)\]\[rid=[^\]\r\n]{1,128}\])/, '');
}

/** `onFinding(finding, line)` lets a caller keep its own bounded, redacted
 * signature of the analyzed line; the collector itself never retains text. */
export function createModelEvalLogCollector(phase, { maxLineChars = MAX_PARTIAL_LINE_CHARS, onFinding, producer, pytestProgress = false } = {}) {
  if (producer !== undefined && producer !== 'python-http-preview' && producer !== 'firefox-native-browser' && producer !== 'webkit-native-browser' && producer !== 'chromium-headless-browser') throw new Error('Unknown process log producer');
  const state = {
    phase,
    buffers: { stdout: "", stderr: "" },
    overflow: { stdout: false, stderr: false },
    droppedBytes: 0,
    droppedLineCount: 0,
    capturedBytes: 0,
    capturedLineCount: 0,
    analyzedLineCount: 0,
    blankLineCount: 0,
    classificationCounts: {
      runtime: 0,
      processWarning: 0,
      processError: 0,
      control: 0,
      other: 0,
    },
    levelCounts: { debug: 0, info: 0, warn: 0, error: 0 },
    streamLineCounts: { stdout: 0, stderr: 0 },
    sourceCounts: {},
    activeCases: new Set(),
    findings: new Map(),
    reportPaths: [],
  };
  const contexts = new Map();
  let context = state;
  let attribution = {};
  let currentLine;

  const addFinding = (severity, code, source) => {
    const finding = {
      severity,
      code,
      count: 1,
      phase,
      ...(source ? { source } : {}),
      ...attribution,
      detail: findingDetail(code),
    };
    const key = findingKey(finding);
    const existing = state.findings.get(key);
    if (existing) existing.count += 1;
    else state.findings.set(key, { ...finding });
    onFinding?.(finding, currentLine);
  };

  const providerRetryWarning = () => {
    state.classificationCounts.processWarning += 1;
    state.levelCounts.warn += 1;
    state.sourceCounts['agent-runner'] = (state.sourceCounts['agent-runner'] || 0) + 1;
    context.stderrContext = undefined;
    context.stderrPayload = false;
    context.nodeToolDiagnostic = false;
    context.nodeToolPayloadRemaining = 0;
    addFinding('warning', 'provider-request-retry', 'agent-runner');
  };

  const analyzeLine = (stream, rawLine) => {
    state.capturedLineCount += 1;
    state.analyzedLineCount += 1;
    state.streamLineCounts[stream] += 1;
    let line = rawLine.replace(/\r$/, "").replace(/\x1b\[[0-9;]*m/g, '');
    if (pytestProgress) line = normalizePytestLogFrame(line);
    const framed = line.match(CASE_LOG_RE);
    const legacyKey = state.activeCases.size === 1 ? [...state.activeCases][0] : undefined;
    const key = framed?.[1] ?? legacyKey;
    attribution = framed ? { caseKey: key, attribution: 'explicit' }
      : key ? { caseKey: key, attribution: 'legacy-marker' }
      : state.activeCases.size > 1 ? { attribution: 'ambiguous' } : {};
    if (framed) line = framed[2];
    currentLine = line;
    // Continuation windows belong to one case and stream, not whichever case
    // happened to emit the previous process-wide warning.
    const contextKey = `${stream}:${key ?? '<unattributed>'}`;
    if (!contexts.has(contextKey)) contexts.set(contextKey, {});
    context = contexts.get(contextKey);
    if (!line.trim()) {
      context.webkitSessionDump = false;
      state.blankLineCount += 1;
      return;
    }

    if (context.nativeProviderRetry) {
      const fields = context.nativeProviderRetry;
      if (NATIVE_PROVIDER_RETRY_LINES[fields.length].test(line)) {
        if (fields.length < 4) {
          fields.push(line.trim());
          state.classificationCounts.other += 1;
          return;
        }
        context.nativeProviderRetry = undefined;
        if (isNativeProviderRetry(`[agent-runner] retrying provider request { ${fields.join(' ')} }`)) {
          providerRetryWarning();
          return;
        }
      }
      context.nativeProviderRetry = undefined;
      state.classificationCounts.processError += 1;
      state.levelCounts.error += 1;
      addFinding('error', 'unclassified-stderr', 'stderr');
      return;
    }

    if (context.nodeToolBudgetLine !== undefined) {
      if (NODE_TOOL_BUDGET_LINES[context.nodeToolBudgetLine].test(line)) {
        state.classificationCounts.other += 1;
        context.nodeToolBudgetLine += 1;
        if (context.nodeToolBudgetLine === NODE_TOOL_BUDGET_LINES.length) context.nodeToolBudgetLine = undefined;
      } else {
        context.nodeToolBudgetLine = undefined;
        state.classificationCounts.processError += 1;
        state.levelCounts.error += 1;
        addFinding("error", "unclassified-stderr", "stderr");
      }
      return;
    }

    if (producer === 'webkit-native-browser' && stream === 'stderr') {
      const record = WEBKIT_MEDIA_RECORD_RE.test(line);
      const row = context.webkitSessionDump && WEBKIT_MEDIA_SESSION_RE.test(line);
      context.webkitSessionDump = record ? WEBKIT_MEDIA_DUMP_RE.test(line) : !!row;
      if (record || row) {
        state.classificationCounts.other += 1;
        state.levelCounts.info += 1;
        state.sourceCounts['webkit-native-browser'] = (state.sourceCounts['webkit-native-browser'] || 0) + 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        return;
      }
    }

    const marker = line.match(CASE_MARKER_RE);
    if (marker) {
      context.nodeToolPayloadRemaining = 0;
      context.nodeToolDiagnostic = false;
      state.classificationCounts.control += 1;
      if (marker[1] === "start") state.activeCases.add(marker[2].trim());
      else state.activeCases.delete(marker[2].trim());
      return;
    }
    const report = line.match(REPORT_RE);
    if (report) {
      state.classificationCounts.control += 1;
      state.reportPaths.push(report[1].trim());
      return;
    }

    const serverRuntime = line.match(SERVER_RUNTIME_LOG_RE);
    const runtime = line.match(RUNTIME_LOG_RE) || (serverRuntime && [serverRuntime[0],
      SERVER_LOG_LEVELS[serverRuntime[1]], 'python-server', serverRuntime[2]]);
    if (runtime) {
      context.nodeToolPayloadRemaining = 0;
      context.nodeToolDiagnostic = false;
      let level = runtime[1].toLowerCase();
      const source = runtime[2].trim() || "unknown";
      const message = runtime[3];
      if (serverRuntime && onFinding) {
        // Case expectation/signature consumers understand the common desktop
        // envelope. Give them that message boundary without the Server rid.
        currentLine = `[00:00:00.000] [${level}] [(python-server)] ${message}`;
      }
      // Electron's console bridge labels Node's process-warning protocol as
      // error. Preserve its warning classification without excusing ordinary
      // application errors that merely mention deprecation.
      const nodeDeprecation = level === "error" && source === "console"
        && /^\(node:\d+\) \[DEP\d{4}\] DeprecationWarning: /.test(message);
      const nodeListenerWarning = level === "error" && source === "console"
        && /^\(node:\d+\) MaxListenersExceededWarning: /.test(message);
      if (nodeDeprecation || nodeListenerWarning) level = "warn";
      state.classificationCounts.runtime += 1;
      state.levelCounts[level] += 1;
      state.sourceCounts[source] = (state.sourceCounts[source] || 0) + 1;
      if (level === "error") {
        addFinding("error", "runtime-error", source);
      } else if (level === "warn") {
        addFinding(
          "warning",
          nodeDeprecation ? "node-deprecation-warning"
            : nodeListenerWarning ? "node-runtime-warning"
            : /tool definition description exceeds soft budget/i.test(message)
            ? "tool-definition-soft-budget"
            : "runtime-warning",
          source,
        );
      }
      context.stderrContext = stream === "stderr" && (level === "warn" || level === "error")
        ? level
        : undefined;
      // AgentRunner logs a failed tool by splicing the first 150 characters of
      // the tool result into one warn record, and a tool result carries its own
      // newlines, so that single record arrives as several stderr lines. Only
      // the first one keeps the log prefix; the rest used to fall through to
      // the unclassified branch and fail the run for output the runtime was
      // asked to print. The window opens only for this known emitter and closes
      // at the next log record, so genuinely unknown stderr still fails.
      context.stderrPayload = stream === "stderr" && level === "warn"
        && TOOL_ERROR_PAYLOAD_RE.test(message);
      return;
    }

    // Firefox owns these structured native browser records. Generic stdout
    // and other producers cannot opt into this format by printing its payload.
    if (producer === 'firefox-native-browser') {
      if ((stream === 'stdout' && line === 'Juggler listening to the pipe')
          || (stream === 'stderr' && line === '*** You are running in headless mode.')) {
        state.classificationCounts.control += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        return;
      }
      const vmQueryWarning = stream === 'stderr' && line.startsWith(MACOS_HYPERVISOR_QUERY_WARNING);
      const firefoxLine = vmQueryWarning ? line.slice(MACOS_HYPERVISOR_QUERY_WARNING.length) : line;
      const consoleLevel = stream === 'stdout' && /^console\.(error|warn):(?: |$)/.exec(line)?.[1];
      const scriptLevel = stream === 'stderr' && /^JavaScript (error|warning): (?:resource|chrome|moz-src):\/\/[^\r\n]+, line \d+: /.exec(firefoxLine)?.[1];
      const graphicsError = stream === 'stdout' && line.startsWith('Crash Annotation GraphicsCriticalError: ');
      const rkvWarning = stream === 'stderr' && FIREFOX_RKV_WARNING_RE.test(firefoxLine);
      if (consoleLevel || scriptLevel || graphicsError || rkvWarning || (vmQueryWarning && !firefoxLine)) {
        const cleanupWarning = stream === 'stderr' && firefoxLine === FIREFOX_JUGGLER_PROGRESS_CLEANUP_WARNING;
        const error = !cleanupWarning && (graphicsError || consoleLevel === 'error' || scriptLevel === 'error');
        state.classificationCounts[error ? 'processError' : 'processWarning'] += 1;
        state.levelCounts[error ? 'error' : 'warn'] += 1;
        state.sourceCounts['firefox-native-browser'] = (state.sourceCounts['firefox-native-browser'] || 0) + 1;
        addFinding(error ? 'error' : 'warning', cleanupWarning ? 'firefox-juggler-cleanup-warning' : error ? 'firefox-runtime-error' : 'firefox-runtime-warning', 'firefox-native-browser');
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        return;
      }
    }

    if (stream === "stderr") {
      if (line === '[pi-provider] provider stream failed {') {
        state.classificationCounts.processError += 1;
        state.levelCounts.error += 1;
        state.sourceCounts['pi-provider'] = (state.sourceCounts['pi-provider'] || 0) + 1;
        context.stderrContext = 'error';
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        addFinding('error', 'provider-request-failed', 'pi-provider');
        return;
      }
      if (isNativeProviderRetry(line)) {
        providerRetryWarning();
        return;
      }
      if (line === '[agent-runner] retrying provider request {') {
        state.classificationCounts.other += 1;
        context.nativeProviderRetry = [];
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        return;
      }
      if (line === '[tool-definitions] tool definition description exceeds soft budget; sent untruncated {') {
        state.classificationCounts.runtime += 1;
        state.levelCounts.warn += 1;
        state.sourceCounts['tool-definitions'] = (state.sourceCounts['tool-definitions'] || 0) + 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        context.nodeToolBudgetLine = 0;
        addFinding('warning', 'tool-definition-soft-budget', 'tool-definitions');
        return;
      }
      // Playwright consumes these exact local inspector readiness/lifecycle
      // records. They are control output, not evidence that a case succeeded.
      if (LOCAL_INSPECTOR_RECORD_RE.test(line) || line === 'Debugger attached.'
          || line === 'For help, see: https://nodejs.org/learn/getting-started/debugging'
          || line === 'Waiting for the debugger to disconnect...') {
        state.classificationCounts.control += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        return;
      }
      // The owning local preview fixture already treats only successful
      // GET/HEAD access records as informational. Default stderr stays strict.
      if (producer === 'python-http-preview' && (PYTHON_PREVIEW_ACCESS_RE.test(line) || PYTHON_PREVIEW_REBUILD_RE.test(line))) {
        state.classificationCounts.other += 1;
        state.levelCounts.info += 1;
        state.sourceCounts['python-http-preview'] = (state.sourceCounts['python-http-preview'] || 0) + 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = false;
        context.nodeToolPayloadRemaining = 0;
        return;
      }
      if (line === '[agent-runner] Tool returned error {') {
        state.classificationCounts.runtime += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = 'root';
        addFinding('warning', 'tool-execution-failed', 'agent-runner');
        return;
      }
      if (context.nodeToolDiagnostic) {
        if (context.nodeToolDiagnostic === 'root' && line === '}') {
          context.nodeToolDiagnostic = false;
          state.classificationCounts.other += 1;
          return;
        }
        if (context.nodeToolDiagnostic === 'root' && line === '  input_parse: {') {
          context.nodeToolDiagnostic = 'input';
          state.classificationCounts.other += 1;
          return;
        }
        if (context.nodeToolDiagnostic === 'input' && /^  \},?$/.test(line)) {
          context.nodeToolDiagnostic = 'root';
          state.classificationCounts.other += 1;
          return;
        }
        if ((context.nodeToolDiagnostic === 'root' ? NODE_TOOL_DIAGNOSTIC_SCALAR_RE : NODE_TOOL_INPUT_DIAGNOSTIC_RE).test(line)) {
          state.classificationCounts.other += 1;
          return;
        }
        context.nodeToolDiagnostic = false;
      }
      // Node-only core-agent uses console.warn rather than Electron's prefixed
      // logger. Admit only its known tool-failure emitter, not arbitrary prose.
      const toolError = /^\[agent-runner\] Tool [A-Za-z0-9_]+ returned error: ?(.*)$/.exec(line);
      if (toolError) {
        state.classificationCounts.runtime += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolPayloadRemaining = Math.max(0, 150 - toolError[1].length);
        addFinding("warning", "tool-execution-failed", "agent-runner");
        return;
      }
      if (context.nodeToolPayloadRemaining > 0) {
        const remaining = context.nodeToolPayloadRemaining;
        context.nodeToolPayloadRemaining = 0;
        if (line.length + 1 <= remaining && !/^\[[A-Za-z]/.test(line)) {
          context.nodeToolPayloadRemaining = remaining - line.length - 1;
          state.classificationCounts.other += 1;
          return;
        }
      }
      if (/^\[model-eval\]\s+network proxy source=/i.test(line)) {
        state.classificationCounts.control += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        return;
      }
      if (phase === "environment" && isRuntimePreparationProgress(line)) {
        state.classificationCounts.control += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        return;
      }
      if (/\bDeprecationWarning\b|\[DEP\d+\]/i.test(line)) {
        state.classificationCounts.processWarning += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = "warning";
        context.stderrPayload = false;
        addFinding("warning", "node-deprecation-warning", "node");
        return;
      }
      // The explicit plain-process prefix also matches the generic Node
      // Warning alternative; resolve its existing category before that branch.
      if (/^warning:/i.test(line)) {
        state.classificationCounts.processWarning += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = "warning";
        context.stderrPayload = false;
        addFinding("warning", "plain-process-warning", "stderr");
        return;
      }
      if (/\b(?:ExperimentalWarning|MaxListenersExceededWarning|Warning):/i.test(line)) {
        state.classificationCounts.processWarning += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = "warning";
        context.stderrPayload = false;
        addFinding("warning", "node-runtime-warning", "node");
        return;
      }
      if (ELECTRON_MACOS_TASK_POLICY_WARNING_RE.test(line)) {
        state.classificationCounts.processWarning += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = "warning";
        context.stderrPayload = false;
        addFinding("warning", "electron-macos-task-policy-warning", "electron");
        return;
      }
      if (producer === 'chromium-headless-browser' && CHROMIUM_MACOS_HEADLESS_WARNINGS.some(pattern => pattern.test(line))) {
        state.classificationCounts.processWarning += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        addFinding('warning', 'chromium-macos-headless-warning', 'chromium-headless-browser');
        return;
      }
      if (ELECTRON_MACOS_SPELLCHECKER_WARNING_RE.test(line)) {
        state.classificationCounts.processWarning += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        addFinding("warning", "electron-macos-spellchecker-warning", "electron");
        return;
      }
      if (/model-eval Electron runner failed|failed to start .*runner/i.test(line)) {
        state.classificationCounts.processError += 1;
        state.levelCounts.error += 1;
        context.stderrContext = "error";
        context.stderrPayload = false;
        addFinding("error", "electron-runner-failure", "launcher");
        return;
      }
      if (
        context.stderrContext
        && STDERR_CONTEXT_CONTINUATION_RE.test(line)
      ) {
        state.classificationCounts.other += 1;
        return;
      }
      if (context.stderrPayload) {
        state.classificationCounts.other += 1;
        return;
      }
      state.classificationCounts.processError += 1;
      state.levelCounts.error += 1;
      context.stderrContext = "error";
      context.stderrPayload = false;
      addFinding("error", "unclassified-stderr", "stderr");
      return;
    }

    if (/^warning:/i.test(line)) {
      state.classificationCounts.processWarning += 1;
      state.levelCounts.warn += 1;
      addFinding("warning", "plain-process-warning", "stdout");
      return;
    }
    state.classificationCounts.other += 1;
  };

  // The end of a line that exceeded the cap: captured, never analyzed.
  const countDroppedLine = (stream) => {
    state.overflow[stream] = false;
    state.capturedLineCount += 1;
    state.streamLineCounts[stream] += 1;
    state.droppedLineCount += 1;
  };

  const ingest = (stream, chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    state.capturedBytes += Buffer.byteLength(text, "utf8");
    state.buffers[stream] += text;
    const lines = state.buffers[stream].split("\n");
    state.buffers[stream] = lines.pop() || "";
    for (const line of lines) {
      if (state.overflow[stream]) {
        state.droppedBytes += Buffer.byteLength(line, "utf8");
        countDroppedLine(stream);
        continue;
      }
      analyzeLine(stream, line);
    }
    if (state.overflow[stream] || state.buffers[stream].length > maxLineChars) {
      state.droppedBytes += Buffer.byteLength(state.buffers[stream], "utf8");
      state.buffers[stream] = "";
      state.overflow[stream] = true;
    }
  };

  const finish = () => {
    for (const stream of ["stdout", "stderr"]) {
      if (state.overflow[stream]) countDroppedLine(stream);
      else if (state.buffers[stream].length) analyzeLine(stream, state.buffers[stream]);
      state.buffers[stream] = "";
    }
    const coveragePassed = state.capturedLineCount === state.analyzedLineCount
      && ![...contexts.values()].some(value => value.nodeToolBudgetLine !== undefined || value.nativeProviderRetry);
    const findings = aggregateFindings([
      ...state.findings.values(),
      ...(coveragePassed ? [] : [{
        severity: "error",
        code: "log-coverage-gap",
        count: 1,
        phase,
        detail: findingDetail("log-coverage-gap"),
      }]),
    ]);
    return {
      policyVersion: 2,
      phase,
      passed: coveragePassed && !findings.some((finding) => finding.severity === "error"),
      requiresReview: findings.length > 0,
      coveragePassed,
      capturedBytes: state.capturedBytes,
      capturedLineCount: state.capturedLineCount,
      analyzedLineCount: state.analyzedLineCount,
      droppedLineCount: state.droppedLineCount,
      droppedBytes: state.droppedBytes,
      blankLineCount: state.blankLineCount,
      classificationCounts: { ...state.classificationCounts },
      levelCounts: { ...state.levelCounts },
      streamLineCounts: { ...state.streamLineCounts },
      sourceCounts: { ...state.sourceCounts },
      findings,
      reportPaths: [...new Set(state.reportPaths)],
    };
  };

  return { ingest, finish, addFinding: (...args) => { attribution = {}; currentLine = undefined; addFinding(...args); } };
}

export function mergeModelEvalLogAnalyses(analyses) {
  const findings = aggregateFindings(analyses.flatMap((analysis) => analysis.findings));
  const sumObject = (key) => Object.fromEntries(
    [...new Set(analyses.flatMap((analysis) => Object.keys(analysis[key] || {})))]
      .map((name) => [
        name,
        analyses.reduce((sum, analysis) => sum + Number(analysis[key]?.[name] || 0), 0),
      ]),
  );
  const capturedLineCount = analyses.reduce((sum, item) => sum + item.capturedLineCount, 0);
  const analyzedLineCount = analyses.reduce((sum, item) => sum + item.analyzedLineCount, 0);
  const coveragePassed = analyses.every((item) => item.coveragePassed)
    && capturedLineCount === analyzedLineCount;
  return {
    policyVersion: 2,
    passed: coveragePassed && !findings.some((finding) => finding.severity === "error"),
    requiresReview: findings.length > 0,
    coveragePassed,
    capturedBytes: analyses.reduce((sum, item) => sum + item.capturedBytes, 0),
    capturedLineCount,
    analyzedLineCount,
    droppedLineCount: analyses.reduce((sum, item) => sum + Number(item.droppedLineCount || 0), 0),
    droppedBytes: analyses.reduce((sum, item) => sum + Number(item.droppedBytes || 0), 0),
    blankLineCount: analyses.reduce((sum, item) => sum + item.blankLineCount, 0),
    classificationCounts: sumObject("classificationCounts"),
    levelCounts: sumObject("levelCounts"),
    streamLineCounts: sumObject("streamLineCounts"),
    sourceCounts: sumObject("sourceCounts"),
    phases: analyses.map((analysis) => ({
      phase: analysis.phase,
      passed: analysis.passed,
      requiresReview: analysis.requiresReview,
      capturedLineCount: analysis.capturedLineCount,
      analyzedLineCount: analysis.analyzedLineCount,
    })),
    findings,
    reportPaths: [...new Set(analyses.flatMap((analysis) => analysis.reportPaths || []))],
  };
}

export function attachProcessLogAnalysis(reportPath, analysis) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.processLogAnalysis = analysis;
  const temporary = `${reportPath}.logs-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, reportPath);
}

export function attachProcessTermination(reportPath, termination) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const observedAt = new Date().toISOString();
  const signal = String(termination?.signal || "unknown").slice(0, 32);
  report.processTermination = {
    kind: "signal",
    signal,
    observedAt,
  };
  if (report.runStatus === "running") {
    report.runStatus = "failed";
    report.completedAt = observedAt;
    report.failure = {
      code: "runner-signaled",
      phase: "process-lifecycle",
      ...(report.progress?.activeCase ? { caseKey: report.progress.activeCase } : {}),
      detail: `the Electron model-evaluation runner was terminated by ${signal}`,
    };
  }
  const temporary = `${reportPath}.termination-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, reportPath);
}

export function resolveReportedPath(cwd, reportedPath) {
  return path.isAbsolute(reportedPath) ? reportedPath : path.resolve(cwd, reportedPath);
}

export function formatProcessLogSummary(analysis) {
  const status = !analysis.passed ? "FAIL" : analysis.requiresReview ? "WARN" : "PASS";
  const findingCounts = analysis.findings
    .map((finding) => `${finding.severity}:${finding.code}=${finding.count}`)
    .join(",");
  return `[model-eval-log-analysis] ${status}`
    + ` coverage=${analysis.analyzedLineCount}/${analysis.capturedLineCount}`
    + ` warnings=${analysis.levelCounts.warn || 0}`
    + ` errors=${analysis.levelCounts.error || 0}`
    + (findingCounts ? ` findings=${findingCounts}` : "");
}
