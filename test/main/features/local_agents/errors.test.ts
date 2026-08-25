import { describe, expect, it } from 'vitest';

import {
  classifyCliRuntimeFailure,
  isHermesApiRetryFailureText,
} from '../../../../src/main/features/local_agents/errors';

describe('local_agents/errors', () => {
  it('classifies Codex model/version rejections as upgrade requirements', () => {
    const error = JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
      },
    });
    expect(classifyCliRuntimeFailure(error)).toBe('upgrade_required');
  });

  it('does not expose unrelated backend failures as version problems', () => {
    expect(classifyCliRuntimeFailure('openclaw exited at /Users/test/private')).toBeNull();
    expect(classifyCliRuntimeFailure(null)).toBeNull();
  });
});

describe('local_agents/errors Hermes terminal text', () => {
  it('matches only the bounded one-line retry-exhaustion result', () => {
    expect(isHermesApiRetryFailureText(
      'API call failed after 3 retries: HTTP 404: 404 Not found. Check the docs for available routes.',
    )).toBe(true);
    expect(isHermesApiRetryFailureText(
      'The API call failed after 3 retries, so I checked another route and recovered.',
    )).toBe(false);
    expect(isHermesApiRetryFailureText(
      'API call failed after 3 retries: HTTP 404\nRecovery: use the local conversation.',
    )).toBe(false);
  });
});
