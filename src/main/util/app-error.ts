export const AppErrorCode = {
  UNKNOWN: 'E_UNKNOWN',
  AUTH_REQUIRED: 'E_NOT_LOGGED_IN',
  NETWORK_TIMEOUT: 'E_NETWORK_TIMEOUT',
  NETWORK_UNAVAILABLE: 'E_NETWORK_UNAVAILABLE',
  SERVER_UNAVAILABLE: 'E_SERVER_UNAVAILABLE',
  BAD_RESPONSE: 'E_BAD_RESPONSE',
} as const;

export type AppErrorCodeValue = typeof AppErrorCode[keyof typeof AppErrorCode];

export interface NormalizedAppError {
  code: AppErrorCodeValue;
  error: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err || '');
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null | undefined)?.code;
}

export function normalizeAppError(err: unknown): NormalizedAppError {
  const raw = errorMessage(err);
  const rawCode = errorCode(err);
  const text = `${String(rawCode || '')} ${raw}`.toLowerCase();

  if (
    rawCode === 'E_NOT_LOGGED_IN'
    || rawCode === 50001
    || rawCode === 50002
    || rawCode === '50001'
    || rawCode === '50002'
    || /\bnot logged in\b|e_not_logged_in|login required|unauthori[sz]ed/.test(text)
  ) {
    return { code: AppErrorCode.AUTH_REQUIRED, error: raw };
  }

  if (/\btimed out after \d+\s*(?:ms|s)\b|\btimeout\b|\btimed out\b|etimedout|und_err_(?:connect|headers|body)_timeout/.test(text)) {
    return { code: AppErrorCode.NETWORK_TIMEOUT, error: raw };
  }

  if (/\bfailed to fetch\b|\bfetch failed\b|networkerror|load failed|econnreset|econnrefused|eai_again|enotfound|getaddrinfo|socket|connection (?:closed|reset|dropped|terminated)/.test(text)) {
    return { code: AppErrorCode.NETWORK_UNAVAILABLE, error: raw };
  }

  if (/^bad response\b|\bbad response\s*\(\d{3}\)|\bnon-json\b|unexpected response/.test(text)) {
    return { code: AppErrorCode.BAD_RESPONSE, error: raw };
  }

  if (/\bhttp\s+(?:5\d\d|429)\b|\b(?:5\d\d|429)\b|bad gateway|service unavailable|gateway timeout|too many requests|rate.?limit|system_busy|server unavailable/.test(text)) {
    return { code: AppErrorCode.SERVER_UNAVAILABLE, error: raw };
  }

  return { code: AppErrorCode.UNKNOWN, error: raw };
}
