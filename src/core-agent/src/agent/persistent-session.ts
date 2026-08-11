import fs from "node:fs";
import path from "node:path";
import type {
  Message,
  MessageContent,
  ToolResultContent,
  ToolUseContent,
} from "../shared/types.js";
import type { ToolObservations } from "../tools/base.js";
import { createLogger } from "../shared/logger.js";
import {
  Session,
  type CompletedWorkEntry,
  type CompletedWorkInput,
  type ConversationHistoryReplaceOptions,
  type ExecutionPlanState,
  type ExecutionPlanUpdate,
  type HistoryResource,
  type SerializedSessionContextState,
} from "./session.js";
import type { WorkspaceObservationEntry } from "./workspace-state.js";

const log = createLogger("persistent-session");

/** Synthetic content written when a prior run aborted after the model
 * issued a tool_use but before the tool produced a tool_result. Both
 * OpenAI and Anthropic chat-completion contracts require tool_use to be
 * immediately followed by tool_result for the same id; history that
 * violates this rule silently hangs the provider stream on the next
 * turn. We heal the history at load time so those runs can recover
 * instead of looping in "thinking…" forever. */
const INTERRUPTED_TOOL_RESULT =
  "[interrupted: previous run aborted before this tool produced a result]";

export type ToolProtocolRepairReport = {
  changed: boolean;
  synthesizedOrphanResults: number;
  droppedUnmatchedResults: number;
  mergedParallelResultMessages: number;
  deduplicatedResults: number;
};

function emptyToolProtocolRepairReport(): ToolProtocolRepairReport {
  return {
    changed: false,
    synthesizedOrphanResults: 0,
    droppedUnmatchedResults: 0,
    mergedParallelResultMessages: 0,
    deduplicatedResults: 0,
  };
}

/**
 * PersistentSession — a `Session` that mirrors every message to a JSONL file
 * and can reload prior messages on construction.
 *
 * This is the standalone equivalent of OpenClaw's per-session JSONL history:
 * each session_id maps 1:1 to a file path, and opening the same session_id
 * again on a later run resumes the conversation.
 *
 * Format (one JSON object per line):
 *   { "role": "user", "content": [...], "ts": 1728000000000 }
 *
 * Unknown / malformed lines are skipped with a warning, not thrown — a
 * partially corrupted file on disk still recovers as much history as
 * possible rather than losing the entire session.
 */
export class PersistentSession extends Session {
  private readonly sessionFile: string;
  private readonly contextFile: string;
  private lastToolProtocolRepairReport = emptyToolProtocolRepairReport();
  private contextMutationDepth = 0;
  private contextWriteDirty = false;
  /** Byte position of each in-memory message's JSONL line. This makes a
   * canonical history tail replacement proportional to the changed tail
   * instead of rewriting every retained turn. */
  private messageStartOffsets: number[] = [];
  private sessionFileSize = 0;

  constructor(opts: {
    /** Absolute path to the jsonl file that backs this session. */
    sessionFile: string;
    /** Per-parent-class option: cap on how many turns stay in memory. */
    maxHistoryTurns?: number;
  }) {
    super({
      maxHistoryTurns: opts.maxHistoryTurns,
    });
    this.sessionFile = opts.sessionFile;
    this.contextFile = `${opts.sessionFile}.context.json`;
    this.loadFromDisk();
  }

  /** Path to the backing jsonl file. */
  getSessionFile(): string {
    return this.sessionFile;
  }

  /** Session id derived from the jsonl basename (file stem). Used as
   * `prompt_cache_key` for providers that route cache by opaque string. */
  override getSessionId(): string {
    const base = path.basename(this.sessionFile);
    return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  }

  /**
   * Load prior messages from disk into memory. Called automatically by the
   * constructor; exposed so callers can force a reload (rare — mostly tests).
   */
  loadFromDisk(): void {
    super.clear();
    this.messageStartOffsets = [];
    this.sessionFileSize = 0;
    if (!fs.existsSync(this.sessionFile)) return;

    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.sessionFile);
      this.sessionFileSize = raw.length;
    } catch (err) {
      console.warn(`[persistent-session] failed to read ${this.sessionFile}: ${(err as Error).message}`);
      return;
    }

    let lineStart = 0;
    const loadLine = (lineEnd: number) => {
      const trimmed = raw.subarray(lineStart, lineEnd).toString("utf-8").trim();
      const recordStart = lineStart;
      lineStart = lineEnd + 1;
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as { role?: string; content?: unknown; turnId?: unknown };
        if (
          (obj.role === "user" || obj.role === "assistant" || obj.role === "system") &&
          Array.isArray(obj.content)
        ) {
          super.addMessage(
            obj.role as Message["role"],
            obj.content as MessageContent[],
            Number.isInteger(obj.turnId) && (obj.turnId as number) > 0
              ? obj.turnId as number
              : undefined,
          );
          const dropped = Math.max(0, this.messageStartOffsets.length + 1 - this.length);
          if (dropped) this.messageStartOffsets.splice(0, dropped);
          this.messageStartOffsets.push(recordStart);
        }
      } catch {
        // Skip corrupt line — keep going rather than throwing away everything.
      }
    };
    for (let index = 0; index < raw.length; index++) {
      if (raw[index] === 0x0a) loadLine(index);
    }
    if (lineStart < raw.length) loadLine(raw.length);

    // Heal orphan `tool_use` entries — see `healOrphanToolUses` for why.
    // Runs after all lines parse so it operates on the full, loaded history
    // rather than one line at a time.
    if (this.healOrphanToolUses()) {
      this.flushToDisk();
      const report = this.lastToolProtocolRepairReport;
      const detail = { sessionId: this.getSessionId(), ...report };
      if (report.synthesizedOrphanResults || report.droppedUnmatchedResults) {
        log.warn("repaired invalid tool protocol", detail);
      } else {
        log.info("normalized parallel tool results", detail);
      }
    }
    this.loadContextFromDisk();
  }

  /**
   * Heal **and persist** orphan tool_use entries in one call. Returns true
   * when the session needed repair (both in-memory and on disk). Safe to
   * call repeatedly; no-op on a clean session.
   *
   * This is the entry point callers should use *after* a turn ends
   * (successfully, aborted, or errored) to make sure the next turn sees
   * a provider-valid message array — the constructor's load-time heal
   * isn't enough when the session instance is cached across turns (see
   * `model/core-agent/session-store.ts`).
   */
  healAndPersist(): boolean {
    // Heal the cached in-memory session only. We deliberately do NOT flushToDisk:
    // by this point memory has been trimmed to the rolling window, and flushToDisk
    // rewrites the whole jsonl from that window — which would drop history older
    // than the window from the append-only log. The append log stays intact and
    // the constructor's load-time heal re-applies the same (idempotent) fix on the
    // next reload, where memory holds the full history so a flush is lossless.
    return this.healOrphanToolUses();
  }

  getLastToolProtocolRepairReport(): ToolProtocolRepairReport {
    return { ...this.lastToolProtocolRepairReport };
  }

  /**
   * Walk the in-memory history and insert a synthetic `tool_result` for
   * every assistant `tool_use` that isn't followed (in the very next
   * message) by a matching `tool_result`. Those orphans happen when a
   * tool execution was aborted (app kill, user stop, watchdog) after the
   * provider's stream emitted the tool_use but before the runner
   * persisted the result. The next provider call would then send an
   * API-invalid message array and silently hang waiting for a response
   * the server never produces.
   *
   * Returns true if the in-memory state was modified. Callers usually
   * want `healAndPersist()` so disk and memory stay in sync; exposed
   * separately for callers that manage flushing on their own.
   *
   * Heal policy: synthesize `tool_result(isError=true, content="[interrupted: …]")`
   * for each orphan id. If the next message is already a user message
   * carrying other tool_result blocks, append the synthetic ones to that
   * message (one turn = one user response); otherwise insert a new user
   * message before whatever comes next. Idempotent — re-running on an
   * already-healed history is a no-op.
   */
  healOrphanToolUses(): boolean {
    const original = super.getMessages();
    let changed = false;
    const report = emptyToolProtocolRepairReport();

    // Pre-pass — drop orphan tool_results whose toolUseId never appears as
    // a tool_use in any assistant message. Provider APIs reject these with
    // "No tool call found for function call output with call_id ...".
    // Common shape that triggered it: assistant message with only text
    // (the tool_use was lost / never persisted), followed by user messages
    // carrying tool_result blocks — the cluster scan in pass 2 only walks
    // assistant→tool_result clusters, so it won't even visit these orphans.
    const validToolUseIds = new Set<string>();
    for (const m of original) {
      if (m.role !== 'assistant') continue;
      for (const c of m.content) {
        if ((c as { type?: string }).type === 'tool_use') {
          const id = (c as ToolUseContent).id;
          if (id) validToolUseIds.add(id);
        }
      }
    }
    const messages: Message[] = [];
    for (const m of original) {
      if (m.role !== 'user') {
        messages.push(m);
        continue;
      }
      const hasToolResult = m.content.some(
        (c) => (c as { type?: string }).type === 'tool_result',
      );
      if (!hasToolResult) {
        messages.push(m);
        continue;
      }
      const kept = m.content.filter((c) => {
        if ((c as { type?: string }).type !== 'tool_result') return true;
        const id = (c as ToolResultContent).toolUseId;
        return validToolUseIds.has(id);
      });
      if (kept.length === m.content.length) {
        messages.push(m);
      } else {
        changed = true;
        report.droppedUnmatchedResults += m.content.length - kept.length;
        if (kept.length > 0) messages.push({ ...m, content: kept });
        // else: message had ONLY orphan tool_results — drop it entirely
      }
    }

    const fixed: Message[] = [];

    let i = 0;
    while (i < messages.length) {
      const m = messages[i];

      if (m.role !== "assistant") {
        if (m.role === "user" && m.content.some((c) => (c as { type?: string }).type === "tool_result")) {
          const kept = m.content.filter((c) => (c as { type?: string }).type !== "tool_result");
          changed = true;
          report.droppedUnmatchedResults += m.content.length - kept.length;
          if (kept.length > 0) fixed.push({ ...m, content: kept });
        } else {
          fixed.push(m);
        }
        i++;
        continue;
      }

      const toolUses = m.content.filter(
        (c): c is ToolUseContent => (c as { type?: string }).type === "tool_use",
      );
      if (!toolUses.length) {
        fixed.push(m);
        i++;
        continue;
      }

      // Walk the cluster of consecutive *pure* tool_result user messages that
      // follow this assistant turn. The runner's `addToolResult` writes one
      // user message per tool_use_id, so parallel tool_calls expand to N
      // adjacent user messages — we must scan all of them, not just `i+1`.
      // Stops at: next assistant, end of history, or a user message that
      // carries any non-tool_result content (real user text shouldn't be
      // collapsed into the cluster).
      const resultsByCallId = new Map<string, ToolResultContent>();
      let trailingImageMsgs: Message[] = [];
      let j = i + 1;
      while (j < messages.length) {
        const nx = messages[j];
        if (nx.role !== "user") break;
        const onlyToolResults = nx.content.every(
          (c) => (c as { type?: string }).type === "tool_result",
        );
        const onlyImages = nx.content.every(
          (c) => (c as { type?: string }).type === "image",
        );
        if (onlyToolResults) {
          for (const c of nx.content) {
            const tr = c as ToolResultContent;
            // First non-interrupted result wins; otherwise first-seen wins.
            // This drops duplicates (e.g. real result + later synthetic
            // interrupted, or two synthetic markers from repeated heals).
            const existing = resultsByCallId.get(tr.toolUseId);
            const isInterrupted =
              tr.isError === true && tr.content === INTERRUPTED_TOOL_RESULT;
            if (!existing || (existing.content === INTERRUPTED_TOOL_RESULT && !isInterrupted)) {
              resultsByCallId.set(tr.toolUseId, tr);
            }
          }
          j++;
        } else if (onlyImages && resultsByCallId.size > 0) {
          // Image trailer emitted by `addToolResult(...images)` — keep it
          // attached after the merged tool_result message; doesn't break the
          // cluster scan.
          trailingImageMsgs.push(nx);
          j++;
        } else {
          break;
        }
      }

      const allCallIds = toolUses.map((t) => t.id);
      const orphanIds = allCallIds.filter((id) => !resultsByCallId.has(id));
      report.synthesizedOrphanResults += orphanIds.length;
      for (const id of orphanIds) {
        resultsByCallId.set(id, {
          type: "tool_result",
          toolUseId: id,
          content: INTERRUPTED_TOOL_RESULT,
          isError: true,
        });
      }

      // Order results to match the assistant's tool_use declaration order;
      // tool_results whose toolUseId has no matching tool_use in this
      // assistant message are dropped — keeping them produces a
      // function_call_output without function_call, which providers reject
      // with "No tool call found for function call output with call_id ...".
      const orderedResults: MessageContent[] = [];
      let droppedOrphanResults = 0;
      for (const id of allCallIds) {
        const r = resultsByCallId.get(id);
        if (r) orderedResults.push(r);
      }
      for (const id of resultsByCallId.keys()) {
        if (!allCallIds.includes(id)) droppedOrphanResults++;
      }
      report.droppedUnmatchedResults += droppedOrphanResults;

      // Detect whether the rewrite changes anything observable: orphan
      // synthesis, dedup of duplicate tool_call_ids, or merging multiple
      // adjacent user messages into one.
      const originalCluster = messages.slice(i + 1, j);
      const originalToolResultMsgs = originalCluster.filter((mm) =>
        mm.content.every((c) => (c as { type?: string }).type === "tool_result"),
      );
      const originalToolResultCount = originalToolResultMsgs.reduce(
        (sum, mm) => sum + mm.content.length,
        0,
      );
      const distinctOriginalResultIds = new Set(
        originalToolResultMsgs.flatMap((message) =>
          message.content.map((content) =>
            (content as { toolUseId?: unknown }).toolUseId,
          ),
        ),
      ).size;
      report.mergedParallelResultMessages += Math.max(0, originalToolResultMsgs.length - 1);
      report.deduplicatedResults += Math.max(
        0,
        originalToolResultCount - distinctOriginalResultIds,
      );
      if (
        orphanIds.length > 0 ||
        droppedOrphanResults > 0 ||
        originalToolResultMsgs.length > 1 ||
        originalToolResultCount !== orderedResults.length
      ) {
        changed = true;
      }

      fixed.push(m);
      if (orderedResults.length > 0) {
        fixed.push({
          role: "user",
          content: orderedResults,
          ...(m.turnId ? { turnId: m.turnId } : {}),
        });
      }
      for (const im of trailingImageMsgs) fixed.push(im);

      i = j;
    }

    report.changed = changed;
    this.lastToolProtocolRepairReport = report;
    if (!changed) return false;

    // Preserve the rolling summary + resources across the merge — clearing and
    // re-adding would null turnState and drop them (see method doc). On the load
    // path turnState is still null here, so this is a plain message swap.
    this.replaceMessagesPreservingContext(fixed);
    return true;
  }

  /** Override: in-memory add + atomic append to disk. */
  override addMessage(role: Message["role"], content: MessageContent[], turnId?: number): Message {
    const message = super.addMessage(role, content, turnId);
    this.alignOffsetsAfterAppend();
    this.appendToDisk(message);
    this.requestContextWrite();
    return message;
  }

  /** Override: start a tracked UI turn + atomic append to disk. */
  override beginUserTurn(content: MessageContent[]): number {
    const id = super.beginUserTurn(content);
    this.alignOffsetsAfterAppend();
    this.appendToDisk({ role: "user", content, turnId: id });
    this.requestContextWrite();
    return id;
  }

  override replaceConversationHistory(
    messages: readonly Message[],
    source: string,
    options: ConversationHistoryReplaceOptions = {},
  ): number | null {
    const changedFrom = super.replaceConversationHistory(messages, source, options);
    if (changedFrom !== null) this.rewriteTailToDisk(changedFrom);
    this.requestContextWrite();
    return changedFrom;
  }

  override completeActiveTurn(outcome?: string): void {
    super.completeActiveTurn(outcome);
    this.requestContextWrite();
  }

  override addHistoryResource(resource: HistoryResource): void {
    super.addHistoryResource(resource);
    this.requestContextWrite();
  }

  override recordCompletedWork(input: CompletedWorkInput): CompletedWorkEntry | undefined {
    const entry = super.recordCompletedWork(input);
    if (entry) this.requestContextWrite();
    return entry;
  }

  override recordToolObservations(input: {
    toolCallId?: string;
    tool: string;
    observations?: ToolObservations;
  }): WorkspaceObservationEntry | undefined {
    const entry = super.recordToolObservations(input);
    if (entry) this.requestContextWrite();
    return entry;
  }

  override reconcileWorkspaceObservations(): WorkspaceObservationEntry | undefined {
    const entry = super.reconcileWorkspaceObservations();
    if (entry) this.requestContextWrite();
    return entry;
  }

  override updateExecutionPlan(update: ExecutionPlanUpdate): ExecutionPlanState {
    const plan = super.updateExecutionPlan(update);
    this.requestContextWrite();
    return plan;
  }

  override ensureExecutionPlanAnchor(): ExecutionPlanState {
    const plan = super.ensureExecutionPlanAnchor();
    this.requestContextWrite();
    return plan;
  }

  override clearExecutionPlan(): void {
    super.clearExecutionPlan();
    this.requestContextWrite();
  }

  override applyHistorySummary(
    summary: string,
    turnIds: readonly number[],
    throughMessageId?: string,
  ): void {
    super.applyHistorySummary(summary, turnIds, throughMessageId);
    this.requestContextWrite();
  }

  override applyActiveCheckpointSummary(summary: string, checkpointThroughMessageIndex: number): string {
    const appliedSummary = super.applyActiveCheckpointSummary(summary, checkpointThroughMessageIndex);
    this.requestContextWrite();
    return appliedSummary;
  }

  /**
   * Overwrite the backing file with the current in-memory state.
   * Called after `compact()` so the on-disk jsonl matches the compacted view.
   */
  override compact(summary: string): void {
    super.compact(summary);
    this.flushToDisk();
    this.requestContextWrite();
  }

  override withContextMutationBatch<T>(mutate: () => T): T {
    this.contextMutationDepth++;
    try {
      return mutate();
    } finally {
      this.contextMutationDepth--;
      if (this.contextMutationDepth === 0 && this.contextWriteDirty) {
        this.contextWriteDirty = false;
        this.writeContextToDisk();
      }
    }
  }

  /** Truncate the on-disk history to match an empty in-memory session. */
  override clear(): void {
    super.clear();
    this.messageStartOffsets = [];
    this.sessionFileSize = 0;
    this.contextWriteDirty = false;
    try {
      if (fs.existsSync(this.sessionFile)) fs.truncateSync(this.sessionFile, 0);
      if (fs.existsSync(this.contextFile)) fs.unlinkSync(this.contextFile);
    } catch (err) {
      console.warn(`[persistent-session] truncate failed ${this.sessionFile}: ${(err as Error).message}`);
    }
  }

  // ── Disk writes ────────────────────────────────────────────────────────

  private requestContextWrite(): void {
    if (this.contextMutationDepth > 0) {
      this.contextWriteDirty = true;
      return;
    }
    this.writeContextToDisk();
  }

  /**
   * Append a single record to the jsonl file. `fs.appendFileSync` with
   * `{ flag: "a" }` is atomic for writes up to PIPE_BUF (~4K) on POSIX; for
   * larger payloads we fall back to a write+fsync on a tmp file + rename,
   * but in practice a single message is well under that limit.
   */
  private appendToDisk(record: Message): void {
    this.ensureDir();
    const line = JSON.stringify({ ...record, ts: Date.now() }) + "\n";
    try {
      const start = this.sessionFileSize;
      fs.appendFileSync(this.sessionFile, line, "utf-8");
      this.messageStartOffsets.push(start);
      this.sessionFileSize += Buffer.byteLength(line, "utf-8");
    } catch (err) {
      console.warn(`[persistent-session] append failed ${this.sessionFile}: ${(err as Error).message}`);
    }
  }

  /** Account for Session's legacy in-memory head trim before recording the
   * newly appended line offset. The append-only JSONL intentionally retains
   * that older prefix; only the in-memory offset index moves forward. */
  private alignOffsetsAfterAppend(): void {
    const dropped = Math.max(0, this.messageStartOffsets.length + 1 - this.length);
    if (dropped) this.messageStartOffsets.splice(0, dropped);
  }

  /** Replace only the changed suffix. Canonical group history is recoverable
   * from the main conversation log, so an interrupted suffix write is repaired
   * by the next full/incremental rebase; fsync still closes the normal crash
   * window before the new active turn starts. */
  private rewriteTailToDisk(changedFrom: number): void {
    let onDiskSize = -1;
    try {
      onDiskSize = fs.existsSync(this.sessionFile)
        ? fs.statSync(this.sessionFile).size
        : -1;
    } catch { /* full rewrite below */ }
    if (
      changedFrom <= 0
      || changedFrom > this.messageStartOffsets.length
      || onDiskSize !== this.sessionFileSize
    ) {
      this.flushToDisk();
      return;
    }

    const oldLength = this.messageStartOffsets.length;
    const offset = changedFrom < oldLength
      ? this.messageStartOffsets[changedFrom]
      : this.sessionFileSize;
    const tail = this.getMessages().slice(changedFrom);
    const lines = tail.map((message) => JSON.stringify({
      role: message.role,
      content: message.content,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ts: Date.now(),
    }) + "\n");
    const payload = Buffer.from(lines.join(""), "utf-8");

    this.ensureDir();
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.sessionFile, "r+");
      fs.ftruncateSync(fd, offset);
      if (payload.length) fs.writeSync(fd, payload, 0, payload.length, offset);
      fs.fsyncSync(fd);

      const nextOffsets = this.messageStartOffsets.slice(0, changedFrom);
      let position = offset;
      for (const line of lines) {
        nextOffsets.push(position);
        position += Buffer.byteLength(line, "utf-8");
      }
      this.messageStartOffsets = nextOffsets;
      this.sessionFileSize = position;
    } catch (err) {
      console.warn(`[persistent-session] tail rewrite failed ${this.sessionFile}: ${(err as Error).message}`);
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        fd = undefined;
      }
      this.flushToDisk();
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Rewrite the entire file from current in-memory state — used by compact()
   * so the on-disk view drops old content along with memory.
   */
  private flushToDisk(): void {
    this.ensureDir();
    const tmp = `${this.sessionFile}.tmp`;
    try {
      const records = this.getMessages()
        .map((m) => JSON.stringify({
          role: m.role,
          content: m.content,
          ...(m.turnId ? { turnId: m.turnId } : {}),
          ts: Date.now(),
        }) + "\n");
      const lines = records.join("");
      fs.writeFileSync(tmp, lines, "utf-8");
      fs.renameSync(tmp, this.sessionFile);
      this.messageStartOffsets = [];
      let position = 0;
      for (const record of records) {
        this.messageStartOffsets.push(position);
        position += Buffer.byteLength(record, "utf-8");
      }
      this.sessionFileSize = position;
    } catch (err) {
      console.warn(`[persistent-session] flush failed ${this.sessionFile}: ${(err as Error).message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  private loadContextFromDisk(): void {
    if (!fs.existsSync(this.contextFile)) {
      this.restoreContextState(null);
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.contextFile, "utf-8")) as SerializedSessionContextState;
      const repaired = this.restoreContextState(raw);
      if (repaired) {
        const report = this.lastToolProtocolRepairReport;
        const benignParallelNormalization = report.changed
          && report.synthesizedOrphanResults === 0
          && report.droppedUnmatchedResults === 0
          && report.mergedParallelResultMessages > 0;
        const detail = { sessionId: this.getSessionId() };
        if (benignParallelNormalization) {
          log.info("context sidecar normalized after parallel result merge", detail);
        } else {
          log.warn("context sidecar repaired", detail);
        }
        this.writeContextToDisk();
      }
    } catch (err) {
      console.warn(`[persistent-session] failed to read context ${this.contextFile}: ${(err as Error).message}`);
      this.restoreContextState(null);
    }
  }

  private writeContextToDisk(): void {
    const state = this.getSerializedContextState();
    try {
      if (!state) {
        if (fs.existsSync(this.contextFile)) fs.unlinkSync(this.contextFile);
        return;
      }
      this.ensureDir();
      const tmp = `${this.contextFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state) + "\n", "utf-8");
      fs.renameSync(tmp, this.contextFile);
    } catch (err) {
      console.warn(`[persistent-session] context write failed ${this.contextFile}: ${(err as Error).message}`);
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(this.sessionFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
