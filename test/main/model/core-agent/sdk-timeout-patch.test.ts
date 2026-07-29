import { describe, expect, it } from 'vitest';

import { sdkClientOptionsForOrkas } from '../../../../src/main/model/core-agent/sdk-timeout-patch';

describe('sdk request defaults', () => {
  it('keeps long provider calls but gives retry ownership to Orkas', () => {
    expect(sdkClientOptionsForOrkas({ apiKey: 'test-key' })).toEqual({
      apiKey: 'test-key',
      timeout: 3_600_000,
      maxRetries: 0,
    });
  });

  it('preserves an explicit caller override', () => {
    expect(sdkClientOptionsForOrkas({
      timeout: 90_000,
      maxRetries: 1,
    })).toMatchObject({
      timeout: 90_000,
      maxRetries: 1,
    });
  });
});
