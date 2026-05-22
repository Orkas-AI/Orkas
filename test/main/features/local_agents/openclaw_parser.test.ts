import { describe, it, expect } from 'vitest';
import { parseOpenclawReply } from '../../../../src/main/features/local_agents/backends/openclaw';

describe('local_agents/backends/openclaw › parseOpenclawReply', () => {
  it('returns null for empty input', () => {
    expect(parseOpenclawReply('')).toBeNull();
    expect(parseOpenclawReply('   ')).toBeNull();
  });

  it('extracts text + sessionId from a typical openclaw stderr trail', () => {
    const stderr = `[skills] Skipping skill path that resolves outside its configured root.
[tools] read failed: ENOENT
{
  "payloads": [
    { "text": "你好。", "mediaUrl": null }
  ],
  "meta": {
    "durationMs": 17149,
    "agentMeta": {
      "sessionId": "abc-123",
      "provider": "openai-codex",
      "model": "gpt-5.4"
    }
  }
}`;
    const r = parseOpenclawReply(stderr);
    expect(r?.text).toBe('你好。');
    expect(r?.sessionId).toBe('abc-123');
  });

  it('joins multiple payloads with newline', () => {
    const stderr = `{
  "payloads": [
    { "text": "first" },
    { "text": "second" }
  ],
  "meta": { "agentMeta": { "sessionId": "s" } }
}`;
    const r = parseOpenclawReply(stderr);
    expect(r?.text).toBe('first\nsecond');
  });

  it('strips ANSI color escapes before parsing', () => {
    // Real openclaw injects ANSI on log prefixes; the JSON envelope
    // doesn't usually have them, but the function must not break if
    // some upstream future version adds them.
    const stderr = '[36m[skills][39m noise\n{ "payloads": [{ "text": "ok" }], "meta": {} }';
    const r = parseOpenclawReply(stderr);
    expect(r?.text).toBe('ok');
  });

  it('ignores partial / nested JSON noise before the final envelope', () => {
    const stderr = `[tools] {"path":"/x"} read failed
[tools] partial { not closed
{
  "payloads": [{ "text": "final reply" }],
  "meta": {}
}`;
    const r = parseOpenclawReply(stderr);
    expect(r?.text).toBe('final reply');
  });

  it('returns null when no shape-matching JSON found', () => {
    expect(parseOpenclawReply('just some logs, no json')).toBeNull();
    expect(parseOpenclawReply('{"unrelated":42}')).toBeNull();
  });

  it('surfaces error envelope when openclaw reports a failure', () => {
    const stderr = '{"error":"auth required"}';
    const r = parseOpenclawReply(stderr);
    expect(r?.text).toBe('');
    expect(r?.error).toBe('auth required');
  });

  it('handles strings with braces inside (no false brace match)', () => {
    const stderr = `{ "payloads": [{ "text": "code: { foo: { bar } }" }], "meta": {} }`;
    const r = parseOpenclawReply(stderr);
    expect(r?.text).toBe('code: { foo: { bar } }');
  });

  it('extracts usage when meta.agentMeta.usage is present', () => {
    const stderr = `{
  "payloads": [{ "text": "ok" }],
  "meta": {
    "agentMeta": {
      "sessionId": "s1",
      "model": "claude-sonnet-4-6",
      "usage": {
        "input_tokens": 1200,
        "output_tokens": 450,
        "cache_read_input_tokens": 800
      }
    }
  }
}`;
    const r = parseOpenclawReply(stderr);
    expect(r?.usage).toEqual({
      input: 1200,
      output: 450,
      cacheRead: 800,
      model: 'claude-sonnet-4-6',
    });
  });

  it('returns no usage field when the envelope has none (legacy openclaw builds)', () => {
    const stderr = `{
  "payloads": [{ "text": "ok" }],
  "meta": { "agentMeta": { "sessionId": "s1" } }
}`;
    const r = parseOpenclawReply(stderr);
    expect(r?.text).toBe('ok');
    expect((r as any).usage).toBeUndefined();
  });
});
