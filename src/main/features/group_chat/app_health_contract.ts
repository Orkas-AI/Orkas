/** Shared result semantics for the host probe and its evaluation fixture. */
export const APP_HEALTH_TOOL_DESCRIPTION =
  'Return a sanitized read-only snapshot of supported Orkas app-health domains. '
  + 'ok means collection completed; each domain has diagnostic_status. '
  + 'succeeded means the check returned facts, not that the domain is healthy. '
  + 'failed means the check failed and the actual domain state is unknown. '
  + 'Never returns credentials, paths, provider error text, or user content.';

export function appHealthProbeSucceeded<T extends object>(facts: T) {
  return { ...facts, diagnostic_status: 'succeeded' as const };
}

export function appHealthProbeFailed() {
  return {
    diagnostic_status: 'failed' as const,
    state: 'unknown' as const,
    error_code: 'diagnostic_probe_failed' as const,
    message: 'The diagnostic check failed. The actual state of this domain and the cause of any problem are unknown.',
  };
}
