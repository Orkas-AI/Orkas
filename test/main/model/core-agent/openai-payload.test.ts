import { describe, expect, it } from 'vitest';

import { repairOpenAIToolMessageOrder } from '../../../../src/main/model/core-agent/openai-payload';

describe('repairOpenAIToolMessageOrder', () => {
  it('leaves valid assistant tool_calls and tool results untouched', () => {
    const payload = {
      model: 'openai-compatible-1.0',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'one' },
        { role: 'tool', tool_call_id: 'call_2', content: 'two' },
        { role: 'assistant', content: 'done' },
      ],
    };

    expect(repairOpenAIToolMessageOrder(payload)).toBe(payload);
  });

  it('converts orphan tool messages to user context', () => {
    const payload = {
      model: 'openai-compatible-1.0',
      messages: [
        { role: 'user', content: 'continue' },
        { role: 'tool', tool_call_id: 'lost_call', content: 'tool output' },
      ],
    };

    const repaired = repairOpenAIToolMessageOrder(payload) as typeof payload;

    expect(repaired).not.toBe(payload);
    expect(repaired.messages[1]).toEqual({
      role: 'user',
      content: 'Tool result for lost_call was detached from its tool_calls; preserving it as user-visible context.\n\ntool output',
    });
  });

  it('does not let stale pending tool calls survive a user message', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } }],
        },
        { role: 'user', content: 'interrupt' },
        { role: 'tool', tool_call_id: 'call_1', content: 'late result' },
      ],
    };

    const repaired = repairOpenAIToolMessageOrder(payload) as typeof payload;

    expect(repaired.messages[2].role).toBe('user');
    expect(repaired.messages[2].content).toContain('late result');
  });
});
