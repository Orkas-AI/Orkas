import type { ToolObservations } from "./base.js";

// Closed diagnostic vocabulary: values come from validator branches, never
// error-message parsing. Unknown extension fields cannot reach application logs.
const CODES = [
  "E_BAD_INPUT", "E_PATCH_FORMAT", "E_PATCH_TOO_LARGE", "E_PATCH_NO_MATCH", "E_PATCH_AMBIGUOUS",
  "E_NO_MATCH", "E_MULTIPLE_MATCHES", "E_NOT_READ", "E_STALE", "E_REVISION_UNKNOWN",
  "E_REVISION_PATH_MISMATCH", "E_NOT_DIRECTORY", "E_NOT_FOUND",
] as const;
const REASONS = [
  "patch_input", "patch_size", "patch_envelope", "file_limit", "file_header", "file_path",
  "add_line_prefix", "delete_content", "hunk_header", "hunk_limit", "hunk_line_prefix",
  "hunk_without_changes", "missing_hunk", "empty_patch", "no_match", "ambiguous_match",
  "insertion_without_anchor", "range_shape", "range_conflict", "range_unit", "range_integer",
  "range_order", "append_precondition", "revision_unknown", "revision_path", "revision_changed",
  "size_changed", "not_read", "file_changed", "expected_hash_changed", "target_type", "target_missing",
  "target_stat",
] as const;
const COUNTS = [
  "line", "file_index", "hunk_index", "added_lines", "removed_lines", "context_lines", "item_index",
  "match_count",
] as const;
const FLAGS = [
  "begin_marker", "end_marker", "start_present", "end_present", "start_integer", "end_integer",
  "start_in_bounds", "ordered", "revision_provided", "revision_found", "revision_matches",
  "size_provided", "size_valid", "baseline_present", "baseline_changed", "expected_hash_provided",
] as const;
const ENUMS = {
  stage: ["input", "parse", "stat", "freshness", "match"],
  start_type: ["undefined", "null", "array", "object", "string", "number", "boolean", "bigint", "symbol", "function"],
  end_type: ["undefined", "null", "array", "object", "string", "number", "boolean", "bigint", "symbol", "function"],
  target_type: ["file", "directory", "other", "missing", "unknown"],
} as const;
// Patch positions are 1-based; item_index follows the 0-based read-files envelope.
export type FileFailureDiagnostic = {
  code: typeof CODES[number];
  reason: typeof REASONS[number];
} & Partial<Record<typeof COUNTS[number], number>>
  & Partial<Record<typeof FLAGS[number], boolean>>
  & { [K in keyof typeof ENUMS]?: typeof ENUMS[K][number] };

export function fileFailure(
  code: FileFailureDiagnostic["code"], reason: FileFailureDiagnostic["reason"],
  facts: Omit<FileFailureDiagnostic, "code" | "reason"> = {},
): Pick<ToolObservations, "fileFailure"> {
  return { fileFailure: { code, reason, ...facts } };
}

export function fileFailureForLog(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!CODES.includes(raw.code as never) || !REASONS.includes(raw.reason as never)) return undefined;
  const out: Record<string, string | number | boolean> = { code: raw.code as string, reason: raw.reason as string };
  for (const key of COUNTS) {
    const v = raw[key];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[key] = v;
  }
  for (const key of FLAGS) if (typeof raw[key] === "boolean") out[key] = raw[key] as boolean;
  for (const key of Object.keys(ENUMS) as Array<keyof typeof ENUMS>) {
    if ((ENUMS[key] as readonly unknown[]).includes(raw[key])) out[key] = raw[key] as string;
  }
  return out;
}
