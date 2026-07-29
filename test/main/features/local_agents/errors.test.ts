import { describe, expect, it } from 'vitest';

import { classifyCliRuntimeFailure } from '../../../../src/main/features/local_agents/errors';

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
