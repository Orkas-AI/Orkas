/**
 * Canonical projection for user-approved video intent.
 *
 * Production artifacts may accumulate execution facts while they are being
 * produced. Those facts are useful for recovery and auditing, but they are not
 * a new creative decision. Approval identities therefore keep unknown fields
 * fail-closed by default and exclude only:
 *
 * - reserved runtime/catalog envelopes; and
 * - legacy runtime fields already written into plan artifacts;
 * - catalog presentation metadata on a stable voice selection.
 *
 * Stable references (for example route_ref/voice_ref and media sources) remain
 * signed. A new field is also signed unless its owning contract explicitly
 * places it in one of the reserved metadata envelopes.
 */

const RESERVED_METADATA_ENVELOPES = new Set([
  '_runtime',
  '_catalog',
]);

const LEGACY_EXECUTION_FACT_KEYS = new Set([
  'status',
  'produced_path',
  'provider_task_id',
  'generated_at',
  'started_at',
  'updated_at',
  'completed_at',
  'failed_at',
  'error_code',
  'transaction_id',
  'request_id',
  'attempt_number',
  'attempt_count',
  'retry_count',
  'output_sha256',
]);

const VOICE_CATALOG_METADATA_KEYS = new Set([
  'display_name',
  'provider',
  'provider_label',
  'provider_model',
  'model_label',
  'catalog_version',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStableVoiceSelection(value: Record<string, unknown>): boolean {
  return typeof value.route_ref === 'string'
    && !!value.route_ref.trim()
    && typeof value.voice_ref === 'string'
    && !!value.voice_ref.trim();
}

export type VideoApprovalIntentProjectionOptions = {
  /**
   * Artifact-specific schema/implementation fields that do not represent user
   * intent. Only keys at the root of this projection are excluded.
   */
  excludeRootKeys?: Iterable<string>;
};

export function projectVideoApprovalIntent(
  value: unknown,
  options: VideoApprovalIntentProjectionOptions = {},
): unknown {
  const excludedRootKeys = new Set(options.excludeRootKeys || []);

  const project = (current: unknown, depth: number): unknown => {
    if (Array.isArray(current)) return current.map((entry) => project(entry, depth + 1));
    if (!isRecord(current)) return current;

    const stableVoiceSelection = isStableVoiceSelection(current);
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(current).sort()) {
      if (depth === 0 && excludedRootKeys.has(key)) continue;
      if (RESERVED_METADATA_ENVELOPES.has(key)) continue;
      if (LEGACY_EXECUTION_FACT_KEYS.has(key)) continue;
      if (stableVoiceSelection && VOICE_CATALOG_METADATA_KEYS.has(key)) continue;
      projected[key] = project(current[key], depth + 1);
    }
    return projected;
  };

  return project(value, 0);
}
