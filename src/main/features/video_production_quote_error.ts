import { sanitizeLogText } from '../util/log-redact';

/** Configured-service facts only; this result does not choose substitute material. */
export const VIDEO_QUOTE_FAILURE_MESSAGE = 'The configured generation service could not be checked, so this generation request was not sent.';

export class VideoProductionQuoteError extends Error {
  readonly serverCode?: number | string;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
    serverCode?: unknown,
  ) {
    // Preserve the existing message for callers that do not read structured fields.
    super(`${code}: ${message}`);
    if (typeof serverCode === 'number' && Number.isSafeInteger(serverCode)) this.serverCode = serverCode;
    else if (typeof serverCode === 'string' && serverCode) this.serverCode = sanitizeLogText(serverCode).slice(0, 64);
  }
}

export type VideoQuoteFailureDetails = {
  message: string;
  source_code?: string;
  http_status?: number;
  server_code?: number | string;
};

/** Preserve explicitly supplied fields; never classify a failure from its prose. */
export function videoQuoteFailureDetails(error: unknown): VideoQuoteFailureDetails {
  const details = error instanceof Error
    ? error as Error & { code?: unknown; httpStatus?: unknown; serverCode?: unknown }
    : undefined;
  const message = details?.message || (typeof error === 'string' ? error : '');
  const serverCode = details?.serverCode;
  return {
    message: sanitizeLogText(message) || 'No error details were provided.',
    ...(typeof details?.code === 'string' && details.code ? { source_code: sanitizeLogText(details.code).slice(0, 64) } : {}),
    ...(typeof details?.httpStatus === 'number' && Number.isInteger(details.httpStatus)
      && details.httpStatus >= 100 && details.httpStatus <= 599 ? { http_status: details.httpStatus } : {}),
    ...(typeof serverCode === 'number' && Number.isSafeInteger(serverCode) ? { server_code: serverCode }
      : typeof serverCode === 'string' && serverCode ? { server_code: sanitizeLogText(serverCode).slice(0, 64) } : {}),
  };
}
