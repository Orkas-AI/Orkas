import { expect, it } from 'vitest';
import { prepareChatReasoningReplay } from '../src/providers/chat-reasoning-replay.js';
import { buildPiContextForTest } from '../src/providers/pi-provider.js';
import { replayOrigin } from '../src/providers/replay-compatibility.js';
import type { MessageContent } from '../src/shared/types.js';

const model = { api: 'openai-completions' as const, provider: 'custom', id: 'fixture', name: 'fixture',
  baseUrl: 'https://fixture.invalid/v1', reasoning: true, input: ['text' as const], contextWindow: 10000,
  maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const thought: MessageContent = { type: 'thinking', thinking: 'Original thought.', thinkingSignature: 'reasoning_content',
  replayOrigin: replayOrigin(model) };
const context = (content: MessageContent[]) => buildPiContextForTest([{ role: 'assistant', content }], undefined, undefined, model);

it('fails before transport on missing or changed serialization rather than leaking internal text', () => {
  const source = context([thought]);
  const before = JSON.stringify(source);
  const replay = prepareChatReasoningReplay(source, model);
  expect(replay.active).toBe(true);
  expect(() => replay.restore({})).toThrow('Chat reasoning replay payload is unavailable');
  expect(() => replay.restore({ messages: [] })).toThrow('Chat reasoning replay serializer mismatch');
  expect(JSON.stringify(source)).toBe(before);
});

it.each(([
  [], [{ type: 'text', text: 'Answer.' }],
  [{ ...thought, thinking: '' }], [{ ...thought, redacted: true }],
  [{ ...thought, thinkingSignature: 'opaque-signature' }],
  [thought, { type: 'tool_use', id: 'call_fixture', name: 'inspect', input: {} }],
] as MessageContent[][]).map(content => ({ content })))('leaves noneligible history unchanged: %#', ({ content }) => {
  const source = context(content);
  const replay = prepareChatReasoningReplay(source, model);
  const payload = { messages: [] };
  expect(replay.active).toBe(false);
  expect(replay.context).toBe(source);
  expect(replay.restore(payload)).toBe(payload);
});

it('removes only its own sentinel, preserves native reasoning and never revives SDK-omitted state', () => {
  const source = context([thought]);
  const replay = prepareChatReasoningReplay(source, model);
  const assistant = replay.context.messages[0];
  if (assistant.role !== 'assistant') throw new Error('Missing assistant fixture');
  const marker = assistant.content.at(-1);
  if (marker?.type !== 'text') throw new Error('Missing internal fixture marker');
  const user = { role: 'user', content: 'orkas-chat-replay:user-owned literal' };
  expect(replay.restore({ messages: [user, { role: 'assistant', content: marker.text, reasoning_content: thought.thinking }] }))
    .toEqual({ messages: [user, { role: 'assistant', content: null, reasoning_content: thought.thinking }] });
  expect(replay.restore({ messages: [{ role: 'assistant', content: marker.text }] })).toEqual({ messages: [] });
  // A declared SDK thinking-as-text format is retained without our sentinel.
  expect(replay.restore({ messages: [{ role: 'assistant', content: [
    { type: 'text', text: thought.thinking }, { type: 'text', text: marker.text },
  ] }] })).toEqual({ messages: [{ role: 'assistant', content: [{ type: 'text', text: thought.thinking }] }] });
});

it('does not change another API transport', () => {
  const source = context([thought]);
  const replay = prepareChatReasoningReplay(source, { ...model, api: 'openai-responses' });
  expect(replay.active).toBe(false);
  expect(replay.context).toBe(source);
});
