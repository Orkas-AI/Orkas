import { describe, expect, it } from 'vitest';

import { buildBridgeSystemPrompt } from '../../../../src/main/features/local_agents/runner';

describe('local_agents/runner › supplied conversation context contract', () => {
  it('makes bounded supplied context primary and history tools an omitted-context fallback', () => {
    const prompt = buildBridgeSystemPrompt(['chat.read']);

    expect(prompt).toContain('Use the conversation context supplied in the current prompt');
    expect(prompt).toMatch(/Query only when exact needed context was omitted by the bounded history block/i);
    expect(prompt).toContain('chat_search / chat_read');
    expect(prompt).not.toContain('unresolved local reference');
  });
});
