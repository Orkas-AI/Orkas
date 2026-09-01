import { describe, expect, it } from 'vitest';

import { orkasApiUsageHeaders } from '../../../src/main/features/orkas_api';

describe('Orkas public API usage context', () => {
  it('sends only opaque conversation and turn ids', () => {
    expect(orkasApiUsageHeaders({
      conversationId: 'conv_123',
      turnId: 'turn-456',
    })).toEqual({
      'X-Orkas-Conversation-Id': 'conv_123',
      'X-Orkas-Turn-Id': 'turn-456',
    });
  });

  it('drops unsafe or overlong ids instead of uploading content', () => {
    expect(orkasApiUsageHeaders({
      conversationId: 'private conversation title',
      turnId: 'x'.repeat(65),
    })).toEqual({});
  });
});
