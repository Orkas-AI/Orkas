#!/usr/bin/env node
/**
 * analyze-context-gates — aggregate-only analyzer for context-compaction and
 * anti-spin gate activity in local application logs.
 *
 * Why this exists: every gate already logs its firings, but nothing reads
 * those logs back, so retirement/tuning decisions ("has this gate ever
 * fired?", "how large do checkpoints actually get?", "how often is folded
 * content re-read?") kept stalling on missing evidence. This script turns the
 * rolling local logs into that evidence without new instrumentation.
 *
 * Privacy: the report contains ONLY gate counts, day coverage, and numeric
 * percentiles. Raw log lines are never echoed — logs stay on-machine, the
 * report is shareable.
 *
 * Usage:
 *   node scripts/analyze-context-gates.mjs               # ~/.orkas/data/logs
 *   node scripts/analyze-context-gates.mjs --dir <path>  # explicit log dir
 *   node scripts/analyze-context-gates.mjs --json        # machine-readable
 *
 * Evidence modes (both read-only, aggregate-only):
 *   --sidecars [--data <dir>]      persistent-block water levels across every
 *                                  session sidecar — how full the facts pool /
 *                                  summary / checkpoint actually run, i.e.
 *                                  whether window-derived caps are worth their
 *                                  rotation-semantics cost.
 *   --cold-starts [--data <dir>] [--ttl-minutes N]
 *                                  idle-gap structure across session JSONLs —
 *                                  how often a conversation resumes after the
 *                                  prompt-cache TTL expired and how many bytes
 *                                  of prefix that first request rewrites,
 *                                  i.e. the opportunity a cache-aware eager
 *                                  archive (G.11-A) would harvest.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/** Fixed gate messages: the extracted header message must EQUAL the key.
 *  Substring matching is deliberately avoided — a future "context compaction
 *  startup" line must not count as "context compaction start". */
const EXACT_GATE_MESSAGES = new Map([
  // Layered compaction lifecycle (refined to l1_/l2_ by the record's
  // `phase:` field line).
  ["context compaction start", "compaction_start"],
  ["context compaction done", "compaction_done"],
  ["context compaction failed", "compaction_failed"],
  // Retired 2026-08-14 with the shared summary cache (lifetime ledger:
  // 1 publish / 0 adoptions); kept so historical logs stay readable.
  ["context history summary reused", "shared_summary_reuse"],
  ["shared history summary cache unavailable", "shared_summary_error"],
  ["shared history summary write failed", "shared_summary_error"],
  ["shared history summary boundary missing from session", "shared_summary_error"],
  ["context compaction skipped", "ceiling_diagnostic"],
  ["context compaction summary exceeded soft target", "l2_soft_target_warn"],
  // L3 deterministic floor.
  ["emergency context reduction applied", "l3_applied"],
  ["emergency context reduction found nothing to drop", "l3_nothing_to_drop"],
  // G.9 reactive overflow recovery.
  ["context overflow recovery applied", "g9_recovered"],
  ["context overflow after recovery", "g9_exhausted"],
  ["context overflow with nothing to recover", "g9_declined"],
  ["context overflow persistent shrink failed", "g9_shrink_failed"],
]);

/** Variable-suffix families: prefix match, refined by keyword. */
const PREFIX_GATE_FAMILIES = [
  {
    prefix: "loop_detection:",
    refine: (message) => (message.includes("near") ? "loop_near_dup" : "loop_exact"),
  },
  {
    prefix: "run_progress: nudged model after consecutive unsuccessful tool rounds",
    refine: () => "no_progress_nudge",
  },
  {
    prefix: "run_progress: nudged model after extended read/search-only exploration",
    refine: () => "discovery_nudge",
  },
  {
    prefix: "run_progress: stopped run",
    refine: () => "progress_stop",
  },
];

/** Numeric fields worth a distribution, keyed by the gates they belong to.
 *  `*` accepts the field under any recognized gate record. */
const METRIC_FIELDS = new Map([
  ["appliedCheckpointTokens", ["compaction_done", "l1_done", "l2_done"]],
  ["summaryTextTokens", ["compaction_done", "l1_done", "l2_done"]],
  ["readsSinceLastCompaction", ["*"]],
  ["rereadPaths", ["*"]],
  ["rereadIdenticalContent", ["*"]],
  ["tokensBefore", ["ceiling_diagnostic", "g9_recovered", "g9_declined", "g9_exhausted"]],
  ["foldedGroups", ["g9_recovered", "l3_applied"]],
  ["archivedTurns", ["g9_recovered", "l3_applied"]],
]);

/** Header lines look like:
 *  [2026-08-08 15:50:55.066] [info]  [ (console) ... ] [agent-runner] message {
 *  Indented pretty-printed object fields and free text inside multi-line
 *  values must not classify. */
const HEADER_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[\w+\]\s+\[[^\]]*\]\s+\[[^\]]+\]\s+(.*?)(?:\s\{)?\s*$/;

/** `  phase: 'history_summary',` style pretty-printed field lines. */
const FIELD_STRING_RE = /^\s+(\w+): '([^']*)',?\s*$/;
const FIELD_NUMBER_RE = /^\s+(\w+): (\d+),?\s*$/;

/** `reason:` values are a meaningful sub-dimension only on these gates;
 *  elsewhere the field is unrelated record noise. */
const REASON_GATES = new Set(["ceiling_diagnostic", "progress_stop", "g9_exhausted", "l3_nothing_to_drop", "shared_summary_error"]);

/** Classify one line. Header lines return `{ gate, message }` (gate null for
 *  unrecognized headers — they still close the previous record's field
 *  scope); non-header lines return null. */
export function classifyHeaderLine(line) {
  const match = HEADER_RE.exec(line);
  if (!match) return null;
  const message = match[1].trim();
  const exact = EXACT_GATE_MESSAGES.get(message);
  if (exact) return { gate: exact, message };
  for (const family of PREFIX_GATE_FAMILIES) {
    if (message.startsWith(family.prefix)) {
      return { gate: family.refine(message), message };
    }
  }
  return { gate: null, message };
}

export function percentiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
  return { n: sorted.length, min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

/**
 * Stateful scan of one log's lines. A header line opens a record; field lines
 * belong to it until the next header. Returns gate counts (including
 * `gate:reason` sub-counts) and raw numeric samples per metric.
 */
export function analyzeLines(lines) {
  const gates = new Map();
  const samples = new Map();
  let current = null;

  const bump = (gate, delta = 1) => gates.set(gate, (gates.get(gate) ?? 0) + delta);

  for (const line of lines) {
    const header = classifyHeaderLine(line);
    if (header) {
      current = header.gate ? { gate: header.gate } : null;
      if (header.gate) bump(header.gate);
      continue;
    }
    // A record's fields are the indented pretty-print block under its header.
    // ANY non-indented line — including headers of other transports whose
    // shape the strict regex does not recognize — closes the scope, so
    // unrelated records' fields can never bleed into a gate's counts.
    if (!/^\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const stringField = FIELD_STRING_RE.exec(line);
    if (stringField) {
      const [, name, value] = stringField;
      if (name === "phase") {
        const layer = value === "history_summary" ? "l1" : value === "active_checkpoint" ? "l2" : null;
        if (layer && current.gate.startsWith("compaction_")) {
          bump(current.gate, -1);
          current.gate = `${layer}_${current.gate.slice("compaction_".length)}`;
          bump(current.gate);
        }
      }
      if (name === "reason" && REASON_GATES.has(current.gate)) bump(`${current.gate}:${value}`);
      continue;
    }
    const numberField = FIELD_NUMBER_RE.exec(line);
    if (numberField) {
      const [, name, raw] = numberField;
      const allowedGates = METRIC_FIELDS.get(name);
      if (!allowedGates) continue;
      if (!allowedGates.includes("*") && !allowedGates.includes(current.gate)) continue;
      if (!samples.has(name)) samples.set(name, []);
      samples.get(name).push(Number(raw));
    }
  }

  return {
    gates: Object.fromEntries([...gates.entries()].filter(([, count]) => count > 0).sort()),
    samples: Object.fromEntries(samples),
  };
}

/** Extract the persistent-block water levels from one parsed sidecar. Sizes
 *  only — never content. Absent fields (getSerializedContextState omits empty
 *  ones) read as zero. */
export function summarizeSidecar(sidecar) {
  const facts = Array.isArray(sidecar.historyExactFacts) ? sidecar.historyExactFacts : [];
  return {
    historySummaryChars: typeof sidecar.historySummary === "string" ? sidecar.historySummary.length : 0,
    factsCount: facts.length,
    factsChars: facts.reduce((sum, item) => sum + (typeof item === "string" ? item.length : 0), 0),
    factsEstTokens: facts.reduce((sum, item) => sum + (typeof item === "string" ? estimateTokensMirror(item) : 0), 0),
    checkpointChars: typeof sidecar.activeTurn?.checkpointSummary === "string"
      ? sidecar.activeTurn.checkpointSummary.length
      : 0,
    completedTurns: Array.isArray(sidecar.completedTurns) ? sidecar.completedTurns.length : 0,
    resources: Array.isArray(sidecar.resources) ? sidecar.resources.length : 0,
  };
}

/** Cold-start structure of one session: gaps between consecutive message
 *  timestamps that exceed the cache TTL, plus how many bytes of transcript
 *  preceded each gap (a cheap proxy for the prefix the resuming request must
 *  rewrite as cache_creation). */
export function coldStartsFromTimestamps(entries, ttlMs) {
  const gaps = [];
  for (let i = 1; i < entries.length; i++) {
    const gapMs = entries[i].ts - entries[i - 1].ts;
    if (gapMs > ttlMs) {
      gaps.push({ gapHours: gapMs / 3_600_000, bytesBefore: entries[i].byteOffset });
    }
  }
  return gaps;
}

function collectSessionFiles(dataDir, suffix) {
  const out = [];
  let userDirs = [];
  try {
    userDirs = fs.readdirSync(dataDir);
  } catch {
    return { files: out, dataDirectoryReadable: false, unreadableSessionDirectories: 0 };
  }
  let unreadableSessionDirectories = 0;
  for (const user of userDirs) {
    const sessionsDir = path.join(dataDir, user, "cloud", "sessions");
    let names = [];
    try {
      names = fs.readdirSync(sessionsDir);
    } catch (error) {
      // Not every entry under data/ is a user with cloud sessions. A missing
      // sessions directory is normal; other failures make the sample partial.
      if (error?.code !== "ENOENT") unreadableSessionDirectories += 1;
      continue;
    }
    for (const name of names) {
      if (name.endsWith(suffix)) out.push(path.join(sessionsDir, name));
    }
  }
  return { files: out, dataDirectoryReadable: true, unreadableSessionDirectories };
}

function evidenceCompleteness(collection, processedFiles, skippedFiles) {
  return {
    complete: collection.dataDirectoryReadable
      && collection.unreadableSessionDirectories === 0
      && skippedFiles === 0,
    dataDirectoryReadable: collection.dataDirectoryReadable,
    unreadableSessionDirectories: collection.unreadableSessionDirectories,
    discoveredFiles: collection.files.length,
    processedFiles,
    skippedFiles,
  };
}

function warnIfEvidenceIncomplete(label, evidence) {
  if (evidence.complete) return;
  console.warn(
    `${label} evidence incomplete: dataDirectoryReadable=${evidence.dataDirectoryReadable} `
    + `unreadableSessionDirectories=${evidence.unreadableSessionDirectories} `
    + `skippedFiles=${evidence.skippedFiles}`,
  );
}

function printStats(label, stats) {
  if (!stats) return;
  console.log(`${label.padEnd(30)} n=${stats.n} min=${stats.min} p50=${stats.p50} p90=${stats.p90} max=${stats.max}`);
}

/** Mirror of session.ts HISTORY_EXACT_FACTS_MAX_TOKENS (the facts pool moved
 *  to a single token-denominated budget on 2026-08-14; the count cap is gone
 *  and the per-item char cap is a shape guard, not a pool budget). This
 *  plain-node script cannot import the TS module, so the analyzer test pins
 *  the mirror and the estimator weights equal — a change there fails the test
 *  instead of silently mis-reporting "near cap" against a stale number here. */
export const FACTS_TOKEN_CAP = 6_000;

/** Mirror of session.ts estimateTextTokens (CJK 1.5/char, other 0.25/char,
 *  UTF-16 units) — pinned by the analyzer test's parity fixtures. */
export function estimateTokensMirror(text) {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0x3040 && code <= 0x30FF) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xAC00 && code <= 0xD7AF)
    ) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5 + other / 4);
}

function runSidecarsMode(dataDir, asJson) {
  const collection = collectSessionFiles(dataDir, ".context.json");
  const rows = [];
  let skippedFiles = 0;
  for (const file of collection.files) {
    try {
      rows.push(summarizeSidecar(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch {
      skippedFiles += 1;
    }
  }
  const metric = (name) => percentiles(rows.map((row) => row[name]));
  const nonZero = (name) => rows.filter((row) => row[name] > 0).map((row) => row[name]);
  const evidence = evidenceCompleteness(collection, rows.length, skippedFiles);
  const report = {
    dataDir,
    evidence,
    sidecars: rows.length,
    withHistorySummary: rows.filter((row) => row.historySummaryChars > 0).length,
    withFacts: rows.filter((row) => row.factsCount > 0).length,
    nearFactsTokenCap: rows.filter((row) => row.factsEstTokens >= FACTS_TOKEN_CAP * 0.9).length,
    all: {
      completedTurns: metric("completedTurns"),
      resources: metric("resources"),
    },
    nonZeroOnly: {
      historySummaryChars: percentiles(nonZero("historySummaryChars")),
      factsCount: percentiles(nonZero("factsCount")),
      factsChars: percentiles(nonZero("factsChars")),
      factsEstTokens: percentiles(nonZero("factsEstTokens")),
      checkpointChars: percentiles(nonZero("checkpointChars")),
    },
  };
  warnIfEvidenceIncomplete("sidecar", evidence);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    if (!evidence.dataDirectoryReadable) process.exitCode = 2;
    return;
  }
  console.log(`persistent-block water levels — ${report.sidecars} sidecar(s) under ${dataDir}\n`);
  console.log(`evidence complete: ${report.evidence.complete}   discovered: ${report.evidence.discoveredFiles}   skipped: ${report.evidence.skippedFiles}`);
  console.log(`unreadable session directories: ${report.evidence.unreadableSessionDirectories}\n`);
  console.log(`with history summary: ${report.withHistorySummary}   with facts: ${report.withFacts}`);
  console.log(`near facts TOKEN cap (>=90% of ${FACTS_TOKEN_CAP.toLocaleString("en-US")} estimated): ${report.nearFactsTokenCap}\n`);
  console.log("distributions over sidecars where the block is non-empty:");
  printStats("historySummaryChars", report.nonZeroOnly.historySummaryChars);
  printStats("factsCount", report.nonZeroOnly.factsCount);
  printStats("factsChars", report.nonZeroOnly.factsChars);
  printStats("factsEstTokens", report.nonZeroOnly.factsEstTokens);
  printStats("checkpointChars", report.nonZeroOnly.checkpointChars);
  console.log("\nacross all sidecars:");
  printStats("completedTurns", report.all.completedTurns);
  printStats("resources", report.all.resources);
  if (!evidence.dataDirectoryReadable) process.exitCode = 2;
}

/**
 * Top-level timestamp of one session JSONL record. Every writer appends `ts`
 * as the LAST top-level key (`JSON.stringify({ ...record, ts: Date.now() })`
 * in persistent-session.ts), so the real record time is the `"ts"` adjacent to
 * the closing brace at end of line. Matching the FIRST `"ts"` on the line
 * instead picks up epoch timestamps embedded in message/tool-result content —
 * common in serialized API payloads — and fabricates idle gaps, inflating the
 * cold-start counts this mode exists to measure.
 */
const TS_RE = /"ts":\s*(\d{10,})\s*\}\s*$/;

export function jsonlLineTimestamp(line) {
  const match = TS_RE.exec(line);
  return match ? Number(match[1]) : null;
}

function runColdStartsMode(dataDir, ttlMinutes, asJson) {
  const collection = collectSessionFiles(dataDir, ".jsonl");
  const ttlMs = ttlMinutes * 60_000;
  const perKind = new Map();
  let skippedFiles = 0;
  let processedFiles = 0;
  for (const file of collection.files) {
    const kind = path.basename(file).split("-")[0] || "unknown";
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
      processedFiles += 1;
    } catch {
      skippedFiles += 1;
      continue;
    }
    const entries = [];
    let offset = 0;
    for (const line of raw.split("\n")) {
      const ts = jsonlLineTimestamp(line);
      if (ts !== null) entries.push({ ts, byteOffset: offset });
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
    if (entries.length < 2) continue;
    const gaps = coldStartsFromTimestamps(entries, ttlMs);
    const bucket = perKind.get(kind) ?? { sessions: 0, sessionsWithCold: 0, gapHours: [], kbBefore: [] };
    bucket.sessions += 1;
    if (gaps.length) {
      bucket.sessionsWithCold += 1;
      for (const gap of gaps) {
        bucket.gapHours.push(Math.round(gap.gapHours * 10) / 10);
        bucket.kbBefore.push(Math.round(gap.bytesBefore / 1024));
      }
    }
    perKind.set(kind, bucket);
  }
  const evidence = evidenceCompleteness(collection, processedFiles, skippedFiles);
  const report = {
    dataDir,
    ttlMinutes,
    evidence,
    kinds: Object.fromEntries(
      [...perKind.entries()].sort().map(([kind, bucket]) => [kind, {
        sessions: bucket.sessions,
        sessionsWithColdStart: bucket.sessionsWithCold,
        coldStarts: bucket.gapHours.length,
        gapHours: percentiles(bucket.gapHours),
        transcriptKBRewrittenAtColdStart: percentiles(bucket.kbBefore),
      }]),
    ),
  };
  warnIfEvidenceIncomplete("cold-start", evidence);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    if (!evidence.dataDirectoryReadable) process.exitCode = 2;
    return;
  }
  console.log(`cold-start structure — TTL ${ttlMinutes}min, sessions under ${dataDir}\n`);
  console.log(`evidence complete: ${report.evidence.complete}   discovered: ${report.evidence.discoveredFiles}   skipped: ${report.evidence.skippedFiles}`);
  console.log(`unreadable session directories: ${report.evidence.unreadableSessionDirectories}\n`);
  for (const [kind, stats] of Object.entries(report.kinds)) {
    console.log(`[${kind}] sessions=${stats.sessions} withColdStart=${stats.sessionsWithColdStart} coldStarts=${stats.coldStarts}`);
    printStats("  gapHours", stats.gapHours);
    printStats("  transcriptKB@coldStart", stats.transcriptKBRewrittenAtColdStart);
  }
  console.log("\ntranscriptKB is a byte proxy for the prefix the resuming request rewrites (cache TTL expired).");
  if (!evidence.dataDirectoryReadable) process.exitCode = 2;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const dataFlag = args.indexOf("--data");
  const dataDir = dataFlag >= 0 && args[dataFlag + 1]
    ? args[dataFlag + 1]
    : path.join(os.homedir(), ".orkas", "data");

  if (args.includes("--sidecars")) {
    runSidecarsMode(dataDir, asJson);
    return;
  }
  if (args.includes("--cold-starts")) {
    const ttlFlag = args.indexOf("--ttl-minutes");
    const ttlMinutes = ttlFlag >= 0 && args[ttlFlag + 1] ? Number(args[ttlFlag + 1]) : 60;
    runColdStartsMode(dataDir, ttlMinutes, asJson);
    return;
  }

  const dirFlag = args.indexOf("--dir");
  const logsDir = dirFlag >= 0 && args[dirFlag + 1]
    ? args[dirFlag + 1]
    : path.join(os.homedir(), ".orkas", "data", "logs");

  if (!fs.existsSync(logsDir)) {
    console.error(`log directory not found: ${logsDir}`);
    process.exit(2);
  }
  const files = fs.readdirSync(logsDir).filter((name) => name.endsWith(".log")).sort();
  if (!files.length) {
    console.error(`no .log files under: ${logsDir}`);
    process.exit(2);
  }

  const gateTotals = {};
  const gateDays = {};
  const sampleTotals = {};
  for (const file of files) {
    const day = file.replace(/\.log$/, "");
    const { gates, samples } = analyzeLines(
      fs.readFileSync(path.join(logsDir, file), "utf8").split("\n"),
    );
    for (const [gate, count] of Object.entries(gates)) {
      gateTotals[gate] = (gateTotals[gate] ?? 0) + count;
      (gateDays[gate] ??= new Set()).add(day);
    }
    for (const [name, values] of Object.entries(samples)) {
      (sampleTotals[name] ??= []).push(...values);
    }
  }

  const report = {
    logsDir,
    days: files.map((file) => file.replace(/\.log$/, "")),
    gates: Object.fromEntries(
      Object.entries(gateTotals)
        .sort()
        .map(([gate, count]) => [gate, { count, days: gateDays[gate]?.size ?? 0 }]),
    ),
    metrics: Object.fromEntries(
      Object.entries(sampleTotals).map(([name, values]) => [name, percentiles(values)]),
    ),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`context gate activity — ${report.days.length} day(s) of logs in ${logsDir}\n`);
  console.log("gate                                          count  days");
  for (const [gate, { count, days }] of Object.entries(report.gates)) {
    console.log(`${gate.padEnd(44)}${String(count).padStart(7)}  ${days}`);
  }
  console.log("\nmetric distributions (n / min / p50 / p90 / max)");
  for (const [name, stats] of Object.entries(report.metrics)) {
    if (!stats) continue;
    console.log(`${name.padEnd(30)} n=${stats.n} min=${stats.min} p50=${stats.p50} p90=${stats.p90} max=${stats.max}`);
  }
  console.log("\nGates absent from the table have zero recorded firings in this window.");
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
