import { createHash } from "node:crypto";
import type { ToolReadContinuation, ToolResult } from "../tools/base.js";
import { toolCallSignature, type ToolRoundProgress } from "./loop-guards.js";

/** Stronger than advisory progress: all effects/information must be covered.
 * No result-text interpretation, I/O, replay or model decision. Unmeasured
 * subprocess effects, partial receipts and waits cannot authorize a stop. */
export function completedRepeatKey(
  call: { name: string; input: unknown },
  outcome: { result: ToolResult; err?: unknown; aborted?: boolean; stalled?: boolean; skipped?: boolean },
  progress: ToolRoundProgress,
  before?: ToolReadContinuation,
  after?: ToolReadContinuation,
): string | undefined {
  const { result } = outcome;
  if (progress !== "none" || outcome.err || outcome.aborted || outcome.stalled || outcome.skipped
      || result.isError || result.persistedOutput || result.images?.length || result.endTurn || result.synthesizeAndEndTurn
      || before?.waiting || after?.waiting) return;
  const o = result.observations;
  if (o?.execution || o?.programExecution || o?.coordination || o?.fileFailure
      || o?.fileReadBatch?.failed || o?.resultRetrievalBatch?.failed
      || o?.fileChanges?.some(change => change.coverage === "partial")) return;
  if (o?.fileReadBatch && o.fileReadBatch.succeeded !== o.fileReads?.length) return;
  if ((o?.fileChanges?.length ?? 0) + (o?.fileReads?.length ?? 0) > 256) return;
  const facts: unknown[] = [];
  for (const c of o?.fileChanges ?? []) facts.push(["file_change", c.operation, c.sourcePath,
    c.destinationPath, c.beforeExists, c.afterExists, c.beforeHash, c.afterHash, c.beforeBytes, c.afterBytes]);
  for (const r of o?.fileReads ?? []) facts.push(["file_read", r.path, r.hash, r.charRange, r.lineRange]);
  if (o?.stateMutation) {
    const s = o.stateMutation;
    if (s.changed !== false || !s.scope || !s.version) return;
    facts.push(["state_change", s.scope, s.version]);
  }
  if (before && after && before.version === after.version) facts.push(["continuation", after.version]);
  if (!facts.length || facts.length > 256) return;
  const evidence = JSON.stringify(facts);
  if (evidence.length > 32_768) return;
  return createHash("sha256").update(toolCallSignature(call)).update("\0").update(evidence).digest("hex");
}
