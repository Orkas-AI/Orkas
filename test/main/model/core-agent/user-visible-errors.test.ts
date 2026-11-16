import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../src/main/i18n', () => ({
  t: (key: string, args?: Record<string, string>) => args?.provider ? `${key}:${args.provider}` : key,
}));
import { formatUserVisibleModelError, modelKeyFailureMessage, normalizeKnownModelErrorMessage }
  from '../../../../src/main/model/core-agent/user-visible-errors';

describe('configured provider failure guidance', () => {
  it.each([
    ['auth', 'errors.model_auth_unavailable'],
    ['permission', 'errors.model_permission_unavailable'],
    ['rate_limit', 'errors.model_rate_limited'],
    ['network', 'errors.model_network_unavailable'],
    ['balance', 'errors.model_provider_balance_insufficient'],
  ] as const)('gives actionable %s guidance', (kind, key) => {
    expect(modelKeyFailureMessage(kind)).toBe(key);
  });
  it('attributes a user-owned balance failure to its configured provider', () => {
    expect(modelKeyFailureMessage('balance', { providerLabel: 'My provider' }))
      .toBe('errors.model_provider_balance_insufficient_named:My provider');
    expect(modelKeyFailureMessage(null)).toBeNull();
  });
  it.each([400, 404, 410, 500, 502, 503, 599])('keeps unknown HTTP %s bodies out of user-facing copy', status => {
    const error = Object.assign(new Error('private upstream routing and request details'), { status });
    expect(formatUserVisibleModelError(error)).toBe(status === 400
      ? 'errors.model_request_rejected' : 'errors.model_temporarily_unavailable');
  });
  it.each([
    ['TOOL_RESULT_PERSISTENCE_FAILED', 'errors.tool_result_save_failed'],
    ['SESSION_PERSISTENCE_FAILED', 'errors.session_save_failed'],
    ['CONTEXT_CAPACITY_INSUFFICIENT', 'errors.model_context_capacity_insufficient'],
    ['PROVIDER_CANDIDATES_UNAVAILABLE', 'errors.model_temporarily_unavailable'],
    ['ENOSPC', 'errors.storage_full'],
    ['ECONNRESET', 'errors.model_network_unavailable'],
  ])('keeps structured %s recovery actionable', (code, key) => {
    expect(formatUserVisibleModelError(Object.assign(new Error('opaque failure'), { code }))).toBe(key);
  });
  it('preserves the provider safety refusal instead of misreporting credentials', () => {
    expect(formatUserVisibleModelError(Object.assign(new Error('Provider declined this request'), { code: 'content_filter' })))
      .toBe('Provider declined this request');
  });
  it('preserves the established no-retry legal restriction guidance', () => {
    expect(formatUserVisibleModelError(Object.assign(new Error('unavailable'), { status: 451 })))
      .toBe('errors.model_request_rejected_no_retry');
  });
  it.each(['404 status code (no body)', '410 status code (no body)'])('normalizes the exact SDK empty-body shape %s', text => {
    expect(normalizeKnownModelErrorMessage(text)).toBe('errors.model_temporarily_unavailable');
  });
  it.each(['A document about 404 responses', '404 examples without a status code', 'A note about credits and balance'])('preserves an unrelated look-alike: %s', text => {
    expect(normalizeKnownModelErrorMessage(text)).toBe(text);
    expect(formatUserVisibleModelError(text)).toBe(text);
  });
});
