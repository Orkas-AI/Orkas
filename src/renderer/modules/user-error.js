const USER_ERROR_CODE = {
  UNKNOWN: 'E_UNKNOWN',
  AUTH_REQUIRED: 'E_NOT_LOGGED_IN',
  NETWORK_TIMEOUT: 'E_NETWORK_TIMEOUT',
  NETWORK_UNAVAILABLE: 'E_NETWORK_UNAVAILABLE',
  SERVER_UNAVAILABLE: 'E_SERVER_UNAVAILABLE',
  BAD_RESPONSE: 'E_BAD_RESPONSE',
};

function _userErrorRawMessage(errLike) {
  if (!errLike) return '';
  if (typeof errLike === 'string') return errLike;
  return String(errLike.error || errLike.message || errLike.msg || '');
}

function _userErrorCode(errLike) {
  if (!errLike || typeof errLike === 'string') return '';
  const code = errLike.code;
  const text = String(code || '');
  if (text === '50001' || text === '50002') return USER_ERROR_CODE.AUTH_REQUIRED;
  return text;
}

function _userErrorLabel(key, fallback) {
  try {
    const v = t(key);
    return v && v !== key ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function isUserTechnicalError(errLike) {
  const code = _userErrorCode(errLike);
  if (
    code === USER_ERROR_CODE.NETWORK_TIMEOUT
    || code === USER_ERROR_CODE.NETWORK_UNAVAILABLE
    || code === USER_ERROR_CODE.SERVER_UNAVAILABLE
    || code === USER_ERROR_CODE.BAD_RESPONSE
  ) {
    return true;
  }

  const text = _userErrorRawMessage(errLike).toLowerCase();
  return /(?:^|[\s(:])(?:account|marketplace|sync|relay):\//.test(text)
    || /\btimed out after \d+\s*(?:ms|s)\b|\btimeout\b|\btimed out\b/.test(text)
    || /\bfailed to fetch\b|\bfetch failed\b|networkerror|load failed|econnreset|econnrefused|eai_again|enotfound/.test(text)
    || /^http\s+\d{3}$/i.test(text)
    || /^code\s+\d+$/i.test(text)
    || /^bad response\b/i.test(text);
}

function userErrorMessage(errLike, opts) {
  opts = opts || {};
  const code = _userErrorCode(errLike);
  if (code === USER_ERROR_CODE.AUTH_REQUIRED) {
    return _userErrorLabel(opts.authKey || 'chat.report_login_required', opts.authFallback || 'Please sign in and try again.');
  }

  const fallback = opts.fallbackKey
    ? _userErrorLabel(opts.fallbackKey, opts.fallbackText || '')
    : (opts.fallbackText || '');
  const raw = _userErrorRawMessage(errLike);
  if (isUserTechnicalError(errLike)) return fallback || raw;
  return raw || fallback;
}

function userErrorFromResponse(res, fallbackMessage) {
  const err = new Error((res && (res.error || res.message || res.msg)) || fallbackMessage || 'failed');
  if (res && Object.prototype.hasOwnProperty.call(res, 'code')) err.code = res.code;
  return err;
}

if (typeof window !== 'undefined') {
  window.USER_ERROR_CODE = USER_ERROR_CODE;
  window.userErrorMessage = userErrorMessage;
  window.userErrorFromResponse = userErrorFromResponse;
  window.isUserTechnicalError = isUserTechnicalError;
}
