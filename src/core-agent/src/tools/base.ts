import { estimateTextTokens } from "../shared/token-estimate.js";
import type { FileFailureDiagnostic } from "./file-diagnostics.js";
import type { ToolDefinition } from "../providers/base.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("tool-definitions");

/** Context passed to a tool when it executes. */
export type ToolContext = {
  workingDir?: string;
  signal?: AbortSignal;
  /** Emit user-visible progress while a long-running tool is still executing. */
  emitProgress?: (progress: ToolProgress) => void;
  /** Arbitrary context data tools can read/write. */
  state: Record<string, unknown>;
};

export type ToolProgress = {
  /** Short phase id, e.g. "upload", "poll", "download". */
  phase?: string;
  /** Human-readable status text for the process rail. */
  message: string;
  /** Optional structured metadata for renderers / logs.
   * Set `heartbeat: true` for "still running" keepalive updates that should
   * not reset the runner's tool-idle watchdog. */
  data?: Record<string, unknown>;
};

/** Image content that can ride along with a tool result. */
export type ToolResultImage = {
  /** Base64-encoded bytes (no data: prefix). */
  data: string;
  /** e.g. 'image/jpeg', 'image/png'. */
  mediaType: string;
  /** Optional generic analysis intent for the next model call. The provider
   * adapter transports this beside the image without depending on the tool
   * name that produced it. */
  analysisMode?: "understand" | "quality_review";
};

/** One explicit file read observed by a tool. Host-only: providers receive
 * only ToolResult.content, while Session uses this deterministic metadata to
 * preserve exact coding state across compaction. */
export type FileReadObservation = {
  path: string;
  hash?: string;
  charRange?: [number, number];
  lineRange?: [number, number];
};

/** One committed file mutation. Text snapshots are host-only and bounded by
 * the Session change ledger; they never enter provider tool_result content.
 * beforeExists/afterExists make create/delete/replace semantics unambiguous
 * even when a large or binary file has no inline snapshot. */
export type FileChangeObservation = {
  operation: "create" | "update" | "delete" | "rename";
  sourcePath: string;
  destinationPath?: string;
  beforeExists: boolean;
  afterExists: boolean;
  beforeHash?: string;
  afterHash?: string;
  beforeBytes?: number;
  afterBytes?: number;
  beforeContent?: string;
  afterContent?: string;
  binary?: boolean;
  /** Exact for transactional file tools; partial when inferred around shell. */
  coverage?: "exact" | "partial";
};

export type CommandStreamObservation = {
  bytes: number;
  truncated: boolean;
  ref?: string;
};

/** Structured command outcome retained independently from rendered stdout. */
export type CommandExecutionObservation = {
  status:
    | "succeeded"
    | "failed"
    | "timed_out"
    | "aborted"
    | "output_limit"
    | "start_failed";
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: CommandStreamObservation;
  stderr: CommandStreamObservation;
};

export type ToolObservations = {
  /** Complete durable-state mutation receipt from its owning executor. Scope
   * and version are opaque host-only identities, never model text or logs.
   * changed=false certifies the entire operation had no state effect; version
   * must also cover all returned information. Omit for unmeasured extra work. */
  stateMutation?: { scope: string; version: string; changed: boolean };
  /** Diagnostic-only validator facts. Never affect routing or provider content. */
  fileFailure?: FileFailureDiagnostic;
  /** Host-only outcomes from Result Store retrieval, including failures hidden
   * by a partially successful outer call. Never serialized into model content. */
  resultRetrievalBatch?: {
    requested: number;
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    failures: Array<{ index: number; code: string }>;
  };
  fileReads?: FileReadObservation[];
  /** Host-only outcome of one bounded read_files batch. Partial item failure
   * does not change the outer tool result: consumers use this only for
   * diagnostics and keep successful reads usable. */
  fileReadBatch?: {
    attempted: number;
    succeeded: number;
    failed: number;
    /** Zero-based indexes match the model-visible read-result envelope.
     * Codes are bounded stable labels; paths and messages stay out of
     * telemetry. */
    failures: Array<{ index: number; code: string }>;
  };
  fileChanges?: FileChangeObservation[];
  execution?: CommandExecutionObservation;
  /** Exact identity of the JavaScript evaluated by run_program. The source
   * body and local path stay private; diagnostics may retain this bounded
   * identity to prove that a saved artifact, rather than regenerated inline
   * code, was executed. */
  programExecution?: {
    sourceKind: "inline" | "file";
    sourceSha256: string;
    /** Host-only aggregate of child-tool outcomes. Ordinary child failures do
     * not change run_program's own success state: the program may recover from
     * them and still emit a useful batch result. */
    childCalls: {
      attempted: number;
      succeeded: number;
      failed: number;
      failedTools: Array<{ name: string; count: number }>;
    };
  };
  /** Host-only diagnostic for coordination tools. It records whether accepted
   * state changed, but never controls task progress, termination, or exposure. */
  coordination?: {
    changed: boolean;
  };
};

/** Result returned from a tool execution. */
export type ToolResult = {
  content: string;
  /** Host-only label for the concrete service selected by a generic tool.
   * AgentRunner forwards it to UI events, but only `content` enters model
   * context. Example: `web_search` can identify the provider that answered. */
  displayName?: string;
  /** Deterministic host-only facts produced by the tool. AgentRunner records
   * them with the real tool-call/turn identity; providers never receive this
   * object directly. */
  observations?: ToolObservations;
  /** Host-only handoff for process output that was streamed to a session temp
   * file instead of being truncated at the in-memory capture threshold. The
   * final host result transformer must content-address/adopt this file before
   * the result enters model context. Never expose this path in `content`. */
  streamedOutput?: {
    path: string;
    size: number;
    sourceTruncated?: boolean;
  };
  /** Host-only metadata for an oversized result persisted outside model
   *  context. The runner forwards it to UI events, but only `content` enters
   *  the conversation, so the model never learns the backing path. */
  persistedOutput?: { path: string; size: number; ref: string };
  /** Optional image payload. Delivered to the model as a user message
   *  immediately following the tool_result message (works across providers
   *  even when the provider's tool_result channel doesn't accept images). */
  images?: ToolResultImage[];
  /** Host-selected authoring input; latest set (at most six images) survives
   * active-turn elision/checkpoints. Empty replaces/clears the prior set. */
  imageRetention?: "active_turn";
  /** This result is a document the model was instructed to read whole — a
   *  skill body or its reference. File-tool hosts and core-agent's learned
   *  skill reader set the same semantic hint, so the host result policy can
   *  give it a higher inline ceiling than an ordinary tool dump. It is still
   *  bounded and subject to the per-round ledger. */
  verbatimDocument?: boolean;
  isError?: boolean;
  /** Terminal tool: end the run after committing this result, WITHOUT a
   *  follow-up inference. The model's text streamed in the same round becomes
   *  the final reply; no synthesis call is made. Used for actions that are the
   *  deliberate last act of a turn — e.g. handing the conversation off to
   *  another agent, where a commander "synthesis" turn would be wasted. */
  endTurn?: boolean;
  /** Host-observed reason for an immediate terminal tool boundary. Only
   * honored with endTurn; never inferred from model text or tool content. */
  endTurnReason?: "waiting_input" | "handed_off";
  /** Used with `endTurn` when a terminal bookkeeping tool expects the model to
   * write the user-facing reply in the same response. If that response has no
   * text, the runner permits exactly one tool-free synthesis instead of
   * completing the turn with an empty reply. */
  synthesizeIfNoText?: boolean;
  /** User-boundary tool: commit this result, withhold every tool for exactly
   * one follow-up inference, then end the run with that model-authored reply.
   *
   * Use this when the tool has reached an authoritative boundary that needs a
   * human-readable explanation (for example, a preview that now needs user
   * input). Unlike `endTurn`, the text written before the tool call is not
   * treated as the reply. The follow-up cannot call or retry tools, and the
   * runner accepts it even when a durable execution plan remains open. */
  synthesizeAndEndTurn?: boolean;
};

/** Trusted, ephemeral state for repeat detection on a read continuation. */
export type ToolReadContinuation = {
  /** Opaque revision of the requested result range and its lifecycle state.
   * Unrelated output, timestamps and model arguments must not manufacture a
   * new revision. Host-only; never persisted, logged or sent to a provider. */
  version: string;
  /** True only for an authorized, bounded wait at the live output tail. */
  waiting: boolean;
};

/** A tool that can be called by the agent during an LLM interaction. */
export interface AgentTool {
  /** Tool name (must be unique within an agent run). */
  readonly name: string;
  /** Human-readable description shown to the LLM. */
  readonly description: string;
  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;
  readonly constrainedSampling?: ToolDefinition["constrainedSampling"];

  /** Re-read the model-facing description whenever provider definitions are
   * built. Use only when Host state changes the advertised capability during
   * a run; ordinary tools stay cached. Engine-internal. */
  readonly dynamicDescription?: boolean;

  /** Whether this tool may run concurrently with ADJACENT same-mode tool
   *  calls in one tool-use batch. Defaults to "sequential". Only
   *  side-effect-free, `ctx.state`-non-mutating tools (read / list / grep /
   *  search / web / library reads …) should opt into "parallel"; write / edit /
   *  delete / pdf / generate / connector-call / skill tools stay sequential,
   *  and `bash` is admitted per call through `parallelWhen`.
   *  Engine-internal — never sent to the model. */
  readonly executionMode?: "sequential" | "parallel";

  /** Per-call refinement of `executionMode: "parallel"`: the call joins a
   *  concurrent batch only when this returns true for its input; otherwise it
   *  is a barrier, exactly like an undeclared tool. Pure, synchronous and
   *  bounded — it runs on model-authored input before authorization, and a
   *  throw counts as false. Engine-internal — never sent to the model. */
  readonly parallelWhen?: (input: Record<string, unknown>) => boolean;

  /** Selects who owns the execution deadline. The default is the core-agent
   * runner. Set to "executor" only for delegation tools whose child runtime
   * has its own bounded timeout/cancellation contract. Engine-internal —
   * never sent to the model. */
  readonly executionTimeoutOwner?: "executor";

  /** Inspect an owned read continuation before repeat detection. Pure,
   * synchronous and bounded; no execution, I/O or authorization side effects.
   * Return undefined for other actions, invalid inputs and inaccessible state.
   * Execution still performs its normal validation and authorization. */
  inspectReadContinuation?(input: Record<string, unknown>, ctx: ToolContext): ToolReadContinuation | undefined;

  /** Execute the tool with the given input. */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const TOOL_DESCRIPTION_SOFT_BUDGET_TOKENS = 150;
export const SCHEMA_DESCRIPTION_SOFT_BUDGET_TOKENS = 80;

type CachedToolDefinition = {
  definition: ToolDefinition;
  description: string;
};

const toolDefinitionCache = new WeakMap<AgentTool, CachedToolDefinition>();

/** Convert an AgentTool to the provider ToolDefinition format. */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  const cached = toolDefinitionCache.get(tool);
  if (cached && !tool.dynamicDescription) return cached.definition;
  const description = normalizeDescription(tool.description);
  if (cached?.description === description) return cached.definition;
  warnLongDescriptionOnce(
    `tool:${tool.name}:description`,
    tool.name,
    "tool description",
    estimateTextTokens(description),
    TOOL_DESCRIPTION_SOFT_BUDGET_TOKENS,
  );
  const definition = {
    name: tool.name,
    description,
    inputSchema: compactSchema(tool.inputSchema, tool.name),
    ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
  };
  toolDefinitionCache.set(tool, { definition, description });
  return definition;
}

const DROPPED_SCHEMA_KEYS = new Set([
  "$comment",
  "$schema",
  "example",
  "examples",
  "markdownDescription",
]);

const warnedLongDescriptions = new Set<string>();

function compactSchema(value: Record<string, unknown>, toolName: string): Record<string, unknown> {
  const compacted = compactSchemaValue(value, toolName, "/inputSchema");
  return isRecord(compacted) ? compacted : value;
}

function compactSchemaValue(value: unknown, toolName: string, pointer: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => compactSchemaValue(entry, toolName, `${pointer}/${index}`));
  }
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "description" && typeof entry === "string") {
      const description = normalizeDescription(entry);
      warnLongDescriptionOnce(
        `schema:${toolName}:${pointer}/description`,
        toolName,
        `schema description at ${pointer}`,
        estimateTextTokens(description),
        SCHEMA_DESCRIPTION_SOFT_BUDGET_TOKENS,
      );
      out[key] = description;
    } else {
      out[key] = compactSchemaValue(entry, toolName, `${pointer}/${escapePointerSegment(key)}`);
    }
  }
  return out;
}

function normalizeDescription(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function warnLongDescriptionOnce(
  key: string,
  toolName: string,
  field: string,
  estimatedTokens: number,
  softBudgetTokens: number,
): void {
  if (estimatedTokens <= softBudgetTokens || warnedLongDescriptions.has(key)) return;
  warnedLongDescriptions.add(key);
  log.warn("tool definition description exceeds soft budget; sent untruncated", {
    tool: toolName,
    field,
    estimatedTokens,
    softBudgetTokens,
  });
}

function escapePointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Helper to define a tool inline. */
export function defineTool(opts: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  constrainedSampling?: ToolDefinition["constrainedSampling"];
  executionMode?: "sequential" | "parallel";
  parallelWhen?: AgentTool["parallelWhen"];
  executionTimeoutOwner?: "executor";
  inspectReadContinuation?: AgentTool["inspectReadContinuation"];
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}): AgentTool {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema,
    ...(opts.constrainedSampling ? { constrainedSampling: opts.constrainedSampling } : {}),
    ...(opts.executionMode ? { executionMode: opts.executionMode } : {}),
    ...(opts.parallelWhen ? { parallelWhen: opts.parallelWhen } : {}),
    ...(opts.executionTimeoutOwner ? { executionTimeoutOwner: opts.executionTimeoutOwner } : {}),
    ...(opts.inspectReadContinuation ? { inspectReadContinuation: opts.inspectReadContinuation } : {}),
    execute: opts.execute,
  };
}

/** Scheduling decision for one call. A call is concurrent only when its tool
 *  declared `executionMode: "parallel"` and, if the tool refines that per
 *  call, `parallelWhen` admits this input; every other call is a barrier. */
export function toolCallIsParallel(
  tool: Pick<AgentTool, "executionMode" | "parallelWhen"> | undefined,
  input: unknown,
): boolean {
  if (tool?.executionMode !== "parallel") return false;
  if (!tool.parallelWhen) return true;
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  try { return tool.parallelWhen(record) === true; }
  catch { return false; }
}
