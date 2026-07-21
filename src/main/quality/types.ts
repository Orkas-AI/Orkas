/**
 * Quality validator — shared types.
 *
 * No dependencies on storage / paths / features. Pure data shapes.
 */

export type Level = 'EXTREME' | 'MEDIUM' | 'LOW';

export interface Violation {
  level: Level;
  /** Stable rule id, e.g. "no_credential_path_read" — used by the LLM retry
   *  feedback loop and by the persisted report. */
  rule: string;
  /** Where the violation was found. Format: "<relpath>" or "<relpath>:<line>"
   *  for file-scoped findings; "frontmatter:<key>" for SKILL.md frontmatter;
   *  "agent.json:<jsonPath>" for agent specs. */
  field: string;
  /** Quoted excerpt of the offending content. Trimmed to ≤ 200 chars to keep
   *  the report compact and the LLM feedback JSON cache-friendly. */
  snippet: string;
  /** One-line repair guidance — written for the LLM author + human reader. */
  suggested_fix: string;
}

export interface ValidationReport {
  /** True iff no EXTREME violation. MEDIUM / LOW do not gate write. */
  ok: boolean;
  violations: Violation[];
  /** ISO timestamp of the validation pass. */
  validated_at: string;
  validator_version: string;
}

/** What kind of artifact is being scanned. Determines which red-flag patterns
 *  apply (a Python script gets pattern set A, a SKILL.md body gets set B's
 *  embedded code-block extraction first, etc.). */
export type ScanKind =
  | 'skill_md'      // SKILL.md (frontmatter + embedded code blocks)
  | 'skill_meta'    // Orkas _meta.json sidecar
  | 'script'        // executable file under scripts/ (.py / .sh / .ts / ...)
  | 'agent_json'    // agent.json spec
  | 'other';        // README / assets — skipped

export interface RuleDef {
  id: string;
  level: Level;
  /** File kinds this rule applies to. Empty = applies to all scannable kinds
   *  (excluding 'other'). */
  appliesTo: ScanKind[];
  pattern: RegExp;
  suggested_fix: string;
}

/** Bumped on every rule list change so persisted reports record the schema
 *  they were produced under. Loosely follows the validator module version. */
export const VALIDATOR_VERSION = '0.3.0';
