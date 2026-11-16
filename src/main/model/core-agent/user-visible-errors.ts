import { t } from '../../i18n';
import { classifyKeyFailure, type KeyFailureKind } from './auth-error';
import {
  classifyTransientNetworkErrorForDisplay,
  isStorageFullError,
  isProviderSafetyError,
  isProviderLegalRestrictionError,
} from '../../../core-agent/src/shared/errors';
import { providerErrorFacts, providerCredentialFailure } from '../../../core-agent/src/shared/provider-error-facts';

export function modelKeyFailureMessage(
  kind: KeyFailureKind | null | undefined,
  opts: {
    /** Display label of the user-configured provider, when the caller knows
     * it. Only used to attribute a third-party balance failure. */
    providerLabel?: string;
  } = {},
): string | null {
  switch (kind) {
    case 'balance':
      return opts.providerLabel
        ? t('errors.model_provider_balance_insufficient_named', { provider: opts.providerLabel })
        : t('errors.model_provider_balance_insufficient');
    case 'auth':
      return t('errors.model_auth_unavailable');
    case 'permission':
      return t('errors.model_permission_unavailable');
    case 'rate_limit':
      return t('errors.model_rate_limited');
    case 'network':
      return t('errors.model_network_unavailable');
    default:
      return null;
  }
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const rec = err as { message?: unknown; error?: unknown };
    if (typeof rec.message === 'string' && rec.message) return rec.message;
    if (typeof rec.error === 'string' && rec.error) return rec.error;
  }
  return String(err || 'unknown error');
}

export function normalizeKnownModelErrorMessage(message: string): string {
  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  if (isStorageFullError(compact)) return t('errors.storage_full');
  if (/\b(?:404|410)\s+status code\s*\(\s*no body\s*\)/i.test(compact)) {
    return t('errors.model_temporarily_unavailable');
  }
  if (
    /\b(?:HTTP\s*)?413\b/i.test(compact)
    || /request entity too large|payload too large|content too large/i.test(compact)
    || /client intended to send too large body/i.test(compact)
  ) {
    return t('errors.request_too_large');
  }
  return compact;
}

export function formatUserVisibleModelError(
  err: unknown,
  opts: {
    providerLabel?: string;
  } = {},
): string {
  if ((err as { code?: unknown } | null)?.code === 'TOOL_RESULT_PERSISTENCE_FAILED') return t('errors.tool_result_save_failed');
  if ((err as { code?: unknown } | null)?.code === 'SESSION_PERSISTENCE_FAILED') return t('errors.session_save_failed');
  if (isStorageFullError(err)) return t('errors.storage_full');
  if (isProviderLegalRestrictionError(err)) return t('errors.model_request_rejected_no_retry');
  const code = String((err as { code?: unknown } | null)?.code || '').toUpperCase();
  if (code === 'CONTEXT_CAPACITY_INSUFFICIENT') return t('errors.model_context_capacity_insufficient');
  if (code === 'PROVIDER_CANDIDATES_UNAVAILABLE') return t('errors.model_temporarily_unavailable');
  const providerSafety = isProviderSafetyError(err);
  const keyFailure = providerSafety ? null : providerCredentialFailure(err) ?? classifyKeyFailure(err);
  const classified = modelKeyFailureMessage(keyFailure, {
    ...(opts.providerLabel ? { providerLabel: opts.providerLabel } : {}),
  });
  if (classified) return classified;
  // An unknown 404/410 or server-error response can contain relay account names, internal
  // provider ids, request ids, or raw JSON that is useful only in private
  // diagnostics. Use the already-structured HTTP fact instead of interpreting
  // provider prose. Explicit credential/model-activation codes above retain
  // their more specific recovery guidance.
  const providerStatus = providerErrorFacts(err).status;
  // Unknown bad-request bodies are private diagnostics, not display copy.
  // Preserve classified failures above and the provider's safety refusal below.
  if (providerStatus === 400 && !providerSafety) {
    return t('errors.model_request_rejected');
  }
  if (providerStatus === 404 || providerStatus === 410
    || (providerStatus !== undefined && providerStatus >= 500 && providerStatus <= 599)) {
    return t('errors.model_temporarily_unavailable');
  }
  const transientKind = classifyTransientNetworkErrorForDisplay(err);
  if (transientKind === 'connection_dropped' || transientKind === 'timeout' || transientKind === 'network') {
    return t('errors.model_network_unavailable');
  }
  return normalizeKnownModelErrorMessage(rawMessage(err)
    .replace(/^Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'unknown error');
}
