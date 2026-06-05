import { describe, expect, it } from 'vitest';

import {
  installSseHeaderTimeoutPatch,
  isSseHeaderTimeoutAbortReason,
} from '../../../../src/main/model/core-agent/sse-header-timeout-patch';

describe('SSE header timeout abort patch', () => {
  it('recognizes provider SSE response-header timeout reasons', () => {
    expect(isSseHeaderTimeoutAbortReason(new Error('Codex SSE response headers timed out after 10000ms'))).toBe(true);
    expect(isSseHeaderTimeoutAbortReason('SSE response headers timed out')).toBe(true);
  });

  it('does not classify normal user aborts', () => {
    expect(isSseHeaderTimeoutAbortReason(new Error('Request was aborted'))).toBe(false);
    expect(isSseHeaderTimeoutAbortReason('aborted by user')).toBe(false);
  });

  it('suppresses only the provider header-timeout abort', () => {
    installSseHeaderTimeoutPatch();

    const providerController = new AbortController();
    providerController.abort(new Error('Codex SSE response headers timed out after 10000ms'));
    expect(providerController.signal.aborted).toBe(false);

    const userController = new AbortController();
    userController.abort(new Error('Request was aborted'));
    expect(userController.signal.aborted).toBe(true);
  });
});
