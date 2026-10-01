import fs from "node:fs";
import path from "node:path";

const RUNTIME_LOG_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[(debug|info|warn|error)\]\s+\[\s*\(([^)]*)\)\s*\]\s*(.*)$/i;
const CASE_MARKER_RE = /^\[model-eval-case\]\s+(start|end)\s+(.+)$/;
const CASE_LOG_RE = /^\[model-eval-case-log ([A-Za-z0-9_./:-]{1,240})\] (.*)$/;
const REPORT_RE = /^report=(.+)$/;
const ELECTRON_MACOS_TASK_POLICY_WARNING_RE = /^\[\d+:\d{4}\/\d{6}\.\d+:ERROR:base\/process\/process_mac\.cc:\d+\]\s+task_policy_set\s+TASK_(?:CATEGORY|SUPPRESSION)_POLICY:\s+\(os\/kern\)\s+invalid argument\s+\(4\)$/;
/** The one runtime warning whose message can span several lines: AgentRunner
 *  splices a slice of the failed tool's result, newlines included. */
const TOOL_ERROR_PAYLOAD_RE = /\bTool\s+\S+\s+returned error:/i;

const STDERR_CONTEXT_CONTINUATION_RE = /^(?:\s+|\[\d+\]\s|[}\]]|\(Use\s|<\/?[a-z][\w:.-]*(?:\s[^>]*)?>?\s*$)/i;

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
    case "tool-execution-failed":
      return "a tool failed; inspect its structured call outcome and recovery without erasing the failure";
    case "plain-process-warning":
      return "a non-structured process warning requires review";
    case "electron-runner-failure":
      return "the Electron model-evaluation runner failed before normal completion";
    case "electron-runner-signaled":
      return "the Electron model-evaluation runner was terminated by an operating-system signal";
    case "electron-macos-task-policy-warning":
      return "Chromium could not apply a non-critical macOS task policy to a child process";
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

function aggregateFindings(findings) {
  const aggregated = new Map();
  for (const finding of findings) {
    const key = [
      finding.severity,
      finding.code,
      finding.phase,
      finding.source || "",
      finding.caseKey || "",
      finding.attribution || "",
    ].join("\0");
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

export function createModelEvalLogCollector(phase) {
  const state = {
    phase,
    buffers: { stdout: "", stderr: "" },
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
    findings: [],
    reportPaths: [],
  };
  const contexts = new Map();
  let context = state;
  let attribution = {};

  const addFinding = (severity, code, source) => {
    state.findings.push({
      severity,
      code,
      count: 1,
      phase,
      ...(source ? { source } : {}),
      ...attribution,
      detail: findingDetail(code),
    });
  };

  const analyzeLine = (stream, rawLine) => {
    state.capturedLineCount += 1;
    state.analyzedLineCount += 1;
    state.streamLineCounts[stream] += 1;
    let line = rawLine.replace(/\r$/, "");
    const framed = line.match(CASE_LOG_RE);
    const legacyKey = state.activeCases.size === 1 ? [...state.activeCases][0] : undefined;
    const key = framed?.[1] ?? legacyKey;
    attribution = framed ? { caseKey: key, attribution: 'explicit' }
      : key ? { caseKey: key, attribution: 'legacy-marker' }
      : state.activeCases.size > 1 ? { attribution: 'ambiguous' } : {};
    if (framed) line = framed[2];
    // Continuation windows belong to one case and stream, not whichever case
    // happened to emit the previous process-wide warning.
    const contextKey = `${stream}:${key ?? '<unattributed>'}`;
    if (!contexts.has(contextKey)) contexts.set(contextKey, {});
    context = contexts.get(contextKey);
    if (!line.trim()) {
      state.blankLineCount += 1;
      return;
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

    const runtime = line.match(RUNTIME_LOG_RE);
    if (runtime) {
      context.nodeToolPayloadRemaining = 0;
      context.nodeToolDiagnostic = false;
      const level = runtime[1].toLowerCase();
      const source = runtime[2].trim() || "unknown";
      const message = runtime[3];
      state.classificationCounts.runtime += 1;
      state.levelCounts[level] += 1;
      state.sourceCounts[source] = (state.sourceCounts[source] || 0) + 1;
      if (level === "error") {
        addFinding("error", "runtime-error", source);
      } else if (level === "warn") {
        addFinding(
          "warning",
          /tool definition description exceeds soft budget/i.test(message)
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

    if (stream === "stderr") {
      if (line === '[agent-runner] Tool returned error {') {
        state.classificationCounts.runtime += 1;
        state.levelCounts.warn += 1;
        context.stderrContext = undefined;
        context.stderrPayload = false;
        context.nodeToolDiagnostic = true;
        addFinding('warning', 'tool-execution-failed', 'agent-runner');
        return;
      }
      if (context.nodeToolDiagnostic) {
        if (line === '}') {
          context.nodeToolDiagnostic = false;
          state.classificationCounts.other += 1;
          return;
        }
        if (/^\s+(?:tool: '[A-Za-z0-9_-]+',?|result: \{ text_hash: '[a-f0-9]{12}', text_chars: \d+ \},?)$/.test(line)) {
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

  const ingest = (stream, chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    state.capturedBytes += Buffer.byteLength(text, "utf8");
    state.buffers[stream] += text;
    const lines = state.buffers[stream].split("\n");
    state.buffers[stream] = lines.pop() || "";
    for (const line of lines) analyzeLine(stream, line);
  };

  const finish = () => {
    for (const stream of ["stdout", "stderr"]) {
      if (state.buffers[stream].length) analyzeLine(stream, state.buffers[stream]);
      state.buffers[stream] = "";
    }
    const coveragePassed = state.capturedLineCount === state.analyzedLineCount;
    const findings = aggregateFindings([
      ...state.findings,
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
      blankLineCount: state.blankLineCount,
      classificationCounts: { ...state.classificationCounts },
      levelCounts: { ...state.levelCounts },
      streamLineCounts: { ...state.streamLineCounts },
      sourceCounts: { ...state.sourceCounts },
      findings,
      reportPaths: [...new Set(state.reportPaths)],
    };
  };

  return { ingest, finish, addFinding: (...args) => { attribution = {}; addFinding(...args); } };
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
