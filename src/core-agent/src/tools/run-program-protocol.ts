import type { RunProgramLimits } from "./run-program.js";

export type ProgramErrorDiagnostic = {
  line?: number;
  column?: number;
  frames?: Array<{ line: number; column: number }>;
  sourceExcerpt?: Array<{ line: number; text: string }>;
};

export type ProgramChildResult = {
  ok: boolean;
  content: string;
  displayName?: string;
  artifacts?: Array<{
    path: string;
    operation: "create" | "update" | "delete" | "rename";
    exists: boolean;
    bytes?: number;
    hash?: string;
  }>;
};

export type ProgramVmResult =
  | { status: "completed"; output?: string }
  | { status: "failed"; code: string; message: string; error?: ProgramErrorDiagnostic };

export type ProgramVmRequest = {
  executionId: number;
  code: string;
  toolNames: string[];
  limits: RunProgramLimits;
  deadline: number;
  cancellation: SharedArrayBuffer;
};

export type ProgramHostMessage =
  | { type: "execute"; request: ProgramVmRequest }
  | { type: "result"; executionId: number; callId: number; result: ProgramChildResult }
  | { type: "error"; executionId: number; callId: number; message: string };

export type ProgramWorkerMessage =
  | { type: "ready" }
  | { type: "bootstrap_error" }
  | { type: "call"; executionId: number; callId: number; name: string; inputJson: string }
  | { type: "complete"; executionId: number; result: ProgramVmResult };

// Bound request copies independently of the existing result quotas. These
// limits apply before postMessage, including calls the program never awaits.
export const MAX_PROGRAM_TOOL_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_PROGRAM_AGGREGATE_INPUT_BYTES = 32 * 1024 * 1024;
