import { describe, expect, it } from 'vitest';
import { AppErrorCode, normalizeAppError } from '../../../src/main/util/app-error';

describe('util/app-error', () => {
  it('classifies transport and auth failures into stable client error codes', () => {
    expect(AppErrorCode.NETWORK_TIMEOUT).toBe('E_NETWORK_TIMEOUT');

    expect(normalizeAppError(Object.assign(new Error('not logged in'), { code: 'E_NOT_LOGGED_IN' }))).toMatchObject({
      code: AppErrorCode.AUTH_REQUIRED,
    });

    expect(normalizeAppError(Object.assign(new Error('login required'), { code: '50001' }))).toMatchObject({
      code: AppErrorCode.AUTH_REQUIRED,
    });

    expect(normalizeAppError(new Error('account:/pms/feedback/submit timed out after 60s'))).toMatchObject({
      code: AppErrorCode.NETWORK_TIMEOUT,
    });

    expect(normalizeAppError(new TypeError('fetch failed'))).toMatchObject({
      code: AppErrorCode.NETWORK_UNAVAILABLE,
    });

    expect(normalizeAppError(new Error('bad response (502): <html>'))).toMatchObject({
      code: AppErrorCode.BAD_RESPONSE,
    });
  });
});
