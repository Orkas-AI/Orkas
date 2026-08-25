import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  FACTS_TOKEN_CAP,
  analyzeLines,
  estimateTokensMirror,
  classifyHeaderLine,
  coldStartsFromTimestamps,
  jsonlLineTimestamp,
  percentiles,
  summarizeSidecar,
} from '../../scripts/analyze-context-gates.mjs';
import {
  HISTORY_EXACT_FACTS_MAX_TOKENS,
  estimateTextTokens,
} from '../../src/core-agent/src/agent/session.js';

// Synthetic lines reproducing the electron-log pretty-print shape:
// header line, then indented object fields. The analyzer's evidence feeds
// retirement/tuning decisions, so a parser that over- or under-matches
// produces wrong decisions — both directions are pinned here.
const HEADER = (message: string, level = 'info') =>
  `[2026-08-13 10:00:00.000] [${level}]  [ (console)                     ] [agent-runner] ${message} {`;

describe('analyze-context-gates classification', () => {
  it('classifies real gate header shapes', () => {
    expect(classifyHeaderLine(HEADER('context compaction done'))?.gate).toBe('compaction_done');
    expect(classifyHeaderLine(HEADER('context compaction skipped', 'error'))?.gate).toBe('ceiling_diagnostic');
    expect(classifyHeaderLine(HEADER('emergency context reduction applied', 'error'))?.gate).toBe('l3_applied');
    expect(classifyHeaderLine(HEADER('context overflow recovery applied', 'warn'))?.gate).toBe('g9_recovered');
    expect(
      classifyHeaderLine(
        '[2026-08-13 10:00:01.000] [warn]  [ (console) ] [agent-runner] loop_detection: identical tool call repeated 5x — stopping run',
      )?.gate,
    ).toBe('loop_exact');
    expect(
      classifyHeaderLine(HEADER('run_progress: nudged model after consecutive unsuccessful tool rounds'))?.gate,
    ).toBe('no_progress_nudge');
  });

  it('rejects look-alikes that must not count as gate firings', () => {
    // Message equality, not substring: a different message sharing the prefix.
    expect(classifyHeaderLine(HEADER('context compaction startup checks'))?.gate).toBeNull();
    // An indented FIELD line whose string value quotes a gate message.
    expect(classifyHeaderLine("  note: 'context compaction start',")).toBeNull();
    // Free text inside a multi-line value (no timestamp header shape).
    expect(classifyHeaderLine('context compaction done')).toBeNull();
    // A header from a random module still closes scope but is not a gate.
    expect(classifyHeaderLine(HEADER('workspace observations reconciled'))?.gate).toBeNull();
  });
});

describe('analyze-context-gates aggregation', () => {
  it('refines compaction lifecycle by phase, attributes metrics, splits reasons', () => {
    const lines = [
      HEADER('context compaction done'),
      "  phase: 'history_summary',",
      '  tokensBefore: 30000,', // not allowed under l1_done → ignored
      '  readsSinceLastCompaction: 4,',
      HEADER('context compaction done'),
      "  phase: 'active_checkpoint',",
      '  appliedCheckpointTokens: 1500,',
      HEADER('context compaction skipped', 'error'),
      "  reason: 'layered_triggers_exceeded',",
      '  tokensBefore: 25000,',
      HEADER('workspace observations reconciled'),
      '  appliedCheckpointTokens: 999999,', // out of scope → ignored
      // A foreign-transport record whose header shape the strict regex does
      // not recognize: the non-indented line must CLOSE scope so its fields
      // cannot bleed into the last gate's counts (the bug the first live run
      // exposed: unrelated `reason: 'documents'` rows under every gate).
      HEADER('context compaction skipped', 'error'),
      '2026-08-13T10:00:02.000Z some-other-transport reason line',
      "  reason: 'documents',",
      '  readsSinceLastCompaction: 999,',
    ];
    const { gates, samples } = analyzeLines(lines);
    expect(gates).toMatchObject({
      l1_done: 1,
      l2_done: 1,
      ceiling_diagnostic: 2,
      'ceiling_diagnostic:layered_triggers_exceeded': 1,
    });
    expect(gates).not.toHaveProperty('compaction_done');
    expect(gates).not.toHaveProperty('ceiling_diagnostic:documents');
    expect(samples.appliedCheckpointTokens).toEqual([1500]);
    expect(samples.readsSinceLastCompaction).toEqual([4]);
    expect(samples.tokensBefore).toEqual([25000]);
  });

  it('percentiles summarize without leaking raw values order', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([5, 1, 9, 3, 7])).toEqual({ n: 5, min: 1, p50: 5, p90: 9, max: 9 });
  });
});

describe('evidence modes', () => {
  it('summarizes sidecar water levels as sizes only, tolerating absent fields', () => {
    // getSerializedContextState omits empty fields — a minimal sidecar must
    // read as zeros, and a populated one must report sizes, never content.
    expect(summarizeSidecar({ version: 1, completedTurns: [{}], resources: [] })).toEqual({
      historySummaryChars: 0,
      factsCount: 0,
      factsChars: 0,
      factsEstTokens: 0,
      checkpointChars: 0,
      completedTurns: 1,
      resources: 0,
    });
    const populated = summarizeSidecar({
      historySummary: 'x'.repeat(1_500),
      historyExactFacts: ['- fact=1', '- 长事实'.repeat(10)],
      activeTurn: { checkpointSummary: 'c'.repeat(300) },
      completedTurns: [{}, {}],
      resources: [{}],
    });
    expect(populated.historySummaryChars).toBe(1_500);
    expect(populated.factsCount).toBe(2);
    expect(populated.factsChars).toBe('- fact=1'.length + '- 长事实'.repeat(10).length);
    expect(populated.factsEstTokens).toBe(
      estimateTokensMirror('- fact=1') + estimateTokensMirror('- 长事实'.repeat(10)),
    );
    expect(populated.checkpointChars).toBe(300);
    expect(JSON.stringify(populated)).not.toContain('fact=1');
  });

  it('reads only the trailing top-level ts, never one embedded in content', () => {
    // Accepted: the real writer shape — JSON.stringify({ ...record, ts }) puts
    // the record timestamp as the LAST key before the closing brace.
    expect(jsonlLineTimestamp('{"role":"user","content":[{"type":"text","text":"hi"}],"ts":1755021600000}'))
      .toBe(1755021600000);
    expect(jsonlLineTimestamp('{"role":"assistant","content":[],"turnId":3,"ts":1755021600001}'))
      .toBe(1755021600001);
    // Rejected look-alike: a tool_result whose CONTENT serializes an API
    // payload with its own epoch "ts". Reading that value fabricated an idle
    // gap between the payload's clock and the record's clock, inflating
    // cold-start counts. The record here has no trailing top-level ts at all
    // (legacy line), so it must be skipped, not mis-timed.
    expect(jsonlLineTimestamp('{"role":"user","content":[{"type":"tool_result","content":"{\\"ts\\": 1600000000000, \\"ok\\":true}"}]}'))
      .toBeNull();
    // Rejected: embedded ts present AND a real trailing ts — the trailing one wins.
    expect(jsonlLineTimestamp('{"role":"user","content":[{"type":"tool_result","content":"{\\"ts\\": 1600000000000}"}],"ts":1755021600002}'))
      .toBe(1755021600002);
    // Rejected: non-JSONL noise.
    expect(jsonlLineTimestamp('')).toBeNull();
    expect(jsonlLineTimestamp('"ts": 1600000000000')).toBeNull();
  });

  it('pins the sidecar cap mirror and estimator weights to the session module', () => {
    // The plain-node analyzer cannot import the TS session module, so it
    // mirrors the token cap and the estimator. If this fails, update
    // FACTS_TOKEN_CAP / estimateTokensMirror in the script to match session.ts.
    expect(FACTS_TOKEN_CAP).toBe(HISTORY_EXACT_FACTS_MAX_TOKENS);
    for (const text of ['', 'plain ascii 1234', '中文事实字段', 'かなカナ', '한글', 'mixed 中英 with 😀 and 𠮷']) {
      expect(estimateTokensMirror(text)).toBe(estimateTextTokens(text));
    }
  });

  it('finds cold-start gaps beyond the TTL with their byte offsets', () => {
    const hour = 3_600_000;
    const entries = [
      { ts: 0, byteOffset: 0 },
      { ts: 10 * 60_000, byteOffset: 4_000 },       // 10min gap: warm
      { ts: 10 * 60_000 + 9 * hour, byteOffset: 9_000 }, // 9h gap: cold
      { ts: 10 * 60_000 + 9 * hour + 30_000, byteOffset: 12_000 }, // 30s: warm
    ];
    const gaps = coldStartsFromTimestamps(entries, hour);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapHours).toBeCloseTo(9, 5);
    expect(gaps[0].bytesBefore).toBe(9_000);
    // TTL boundary is exclusive: exactly-TTL gaps are not cold.
    expect(coldStartsFromTimestamps([{ ts: 0, byteOffset: 0 }, { ts: hour, byteOffset: 1 }], hour)).toHaveLength(0);
  });

  it('reports incomplete sidecar evidence without exposing skipped paths or content', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-context-evidence-'));
    const sessionsDir = path.join(tmpDir, 'user-private', 'cloud', 'sessions');
    const unreadableSessions = path.join(tmpDir, 'user-other', 'cloud', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(unreadableSessions), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'valid.context.json'), JSON.stringify({ completedTurns: [{}] }));
    fs.writeFileSync(path.join(sessionsDir, 'private-name.context.json'), '{private-content');
    fs.writeFileSync(unreadableSessions, 'not-a-directory');

    try {
      const result = spawnSync(process.execPath, [
        path.resolve('scripts/analyze-context-gates.mjs'),
        '--sidecars', '--json', '--data', tmpDir,
      ], { encoding: 'utf8' });
      const report = JSON.parse(result.stdout);

      expect(result.status).toBe(0);
      expect(report.evidence).toEqual({
        complete: false,
        dataDirectoryReadable: true,
        unreadableSessionDirectories: 1,
        discoveredFiles: 2,
        processedFiles: 1,
        skippedFiles: 1,
      });
      expect(result.stderr).toContain('sidecar evidence incomplete');
      expect(result.stderr).not.toContain('user-private');
      expect(result.stderr).not.toContain('private-name');
      expect(result.stderr).not.toContain('private-content');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the evidence data directory is unavailable', () => {
    const missingDir = path.join(os.tmpdir(), `orkas-missing-evidence-${process.pid}-${Date.now()}`);
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/analyze-context-gates.mjs'),
      '--cold-starts', '--json', '--data', missingDir,
    ], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(2);
    expect(report.evidence).toMatchObject({
      complete: false,
      dataDirectoryReadable: false,
      discoveredFiles: 0,
      processedFiles: 0,
      skippedFiles: 0,
    });
    expect(result.stderr).toContain('cold-start evidence incomplete');
  });
});
