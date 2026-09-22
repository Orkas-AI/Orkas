import type { FileChangeObservation, FileReadObservation, ToolReadContinuation, ToolResult } from "../tools/base.js";
import { mergeToolRoundProgress, type ToolRoundProgress } from "./loop-guards.js";

type Outcome = { result: ToolResult; err?: unknown; aborted?: boolean; stalled?: boolean };
type Range = [number, number];
const MAX_SOURCES = 512;
const MAX_RANGES = 128;
const MAX_ID_LENGTH = 8192;

/** Committed effects, not the success flag or an interpretation of output prose. */
function changeProgress(change: FileChangeObservation): ToolRoundProgress {
  if (change.beforeExists !== change.afterExists) return "productive";
  if (change.operation === "rename" && change.beforeExists && change.afterExists
      && change.destinationPath && change.destinationPath !== change.sourcePath) return "productive";
  if (!change.beforeExists && !change.afterExists) return "none";
  if (change.beforeHash !== undefined && change.afterHash !== undefined) {
    return change.beforeHash === change.afterHash ? "none" : "productive";
  }
  if (change.beforeBytes !== undefined && change.afterBytes !== undefined) {
    if (change.beforeBytes !== change.afterBytes) return "productive";
    if (change.beforeBytes === 0) return "none";
  }
  return "unknown";
}

/** Run-local evidence of delivered information. Missing facts are unknown.
 * No output/error parsing, workspace scan, persisted state, or model call.
 * Saturation conservatively skips new comparisons instead of declaring evicted
 * information new. A new context window can legitimately reload old sources.
 */
export class ProgressEvidence {
  private reads = new Map<string, Range[]>();
  private continuations = new Set<string>();

  reset(): void {
    this.reads.clear();
    this.continuations.clear();
  }

  observe(name: string, outcome: Outcome, continuation?: ToolReadContinuation, beforeRead?: ToolReadContinuation): ToolRoundProgress {
    const { result } = outcome;
    const failed = Boolean(outcome.aborted || outcome.stalled || outcome.err || result.isError);
    if (!failed && (name === "manage_execution_plan" || name === "tool_load")) return "neutral";
    let progress: ToolRoundProgress = "neutral";
    const observations = result.observations;
    if (observations?.stateMutation) {
      const state = observations.stateMutation;
      progress = state.scope && state.version && typeof state.changed === "boolean"
        ? (state.changed ? "productive" : "none") : "unknown";
    }
    for (const change of observations?.fileChanges ?? []) {
      let effect = changeProgress(change);
      // A partial shell snapshot can demonstrate a change, but a no-op in one
      // observed file does not prove that the entire command did nothing.
      if (effect === "none" && change.coverage === "partial") effect = "unknown";
      progress = mergeToolRoundProgress(progress, effect);
    }
    // A capped receipt does not prove that these exact ranges reached the model.
    if (!result.persistedOutput && !observations?.programExecution) {
      for (const read of observations?.fileReads ?? []) {
        progress = mergeToolRoundProgress(progress, this.observeRead(read));
      }
    } else if (observations?.fileReads?.length) {
      progress = mergeToolRoundProgress(progress, "unknown");
    }
    if (!failed && continuation) {
      let readProgress: ToolRoundProgress = "neutral";
      if (beforeRead?.waiting) {
        // An authorized wait can finish with output. Without the delivered
        // range in the receipt metadata, conservatively keep it neutral.
        readProgress = "neutral";
      } else if (beforeRead && beforeRead.version !== continuation.version) {
        // A producer may advance between the read and result commitment. Its
        // later revision is not proof that those bytes reached this result.
        readProgress = "unknown";
      } else if (!continuation.waiting) {
        const key = JSON.stringify([name, continuation.version]);
        if (key.length > MAX_ID_LENGTH) readProgress = "unknown";
        else if (this.continuations.has(key)) readProgress = "none";
        else if (this.continuations.size >= MAX_SOURCES) readProgress = "unknown";
        else {
          this.continuations.add(key);
          readProgress = "discovery";
        }
      }
      progress = mergeToolRoundProgress(progress, readProgress);
      if (progress === "neutral") return "neutral";
    }
    // Failures may accompany committed effects or useful new reads. Success,
    // exit codes and child counts alone prove neither advancement nor stasis.
    if (failed || observations?.execution || observations?.programExecution
        || observations?.fileReadBatch?.failed || observations?.resultRetrievalBatch?.failed) {
      progress = mergeToolRoundProgress(progress, "unknown");
    }
    return progress === "neutral" ? "unknown" : progress;
  }

  private observeRead(read: FileReadObservation): ToolRoundProgress {
    const bounds = read.charRange ?? read.lineRange;
    const chars = Boolean(read.charRange);
    if (!read.path || !read.hash || !bounds || bounds.length !== 2
        || !bounds.every(Number.isSafeInteger)
        || bounds[0] < (chars ? 0 : 1) || bounds[1] < bounds[0]) return "unknown";
    const start = bounds[0];
    const end = bounds[1] + (chars ? 0 : 1);
    if (!Number.isSafeInteger(end) || start === end) return "unknown";
    const key = JSON.stringify([read.path, read.hash, chars ? "chars" : "lines"]);
    if (key.length > MAX_ID_LENGTH) return "unknown";
    const previous = this.reads.get(key);
    if (!previous && this.reads.size >= MAX_SOURCES) return "unknown";
    const ranges = previous ?? [];
    if (ranges.some(([a, b]) => a <= start && b >= end)) return "none";
    const otherKey = JSON.stringify([read.path, read.hash, chars ? "lines" : "chars"]);
    const incomparable = this.reads.has(otherKey);
    const merged: Range[] = [];
    for (const range of [...ranges, [start, end] as Range].sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    if (merged.length > MAX_RANGES) return "unknown";
    this.reads.set(key, merged);
    return incomparable ? "unknown" : "discovery";
  }
}
