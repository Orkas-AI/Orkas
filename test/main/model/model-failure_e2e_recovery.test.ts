import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Message } from '#core-agent';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-model-recovery-'));
  vi.stubEnv('ORKAS_WORKSPACE_ROOT', root);
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function success() {
  return new Response('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
    model: 'fixture-model', choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

describe('explicit model failures through the host runner and real SDK', () => {
  it.each(['unsupported-image', 'rate-limit'] as const)('%s follows its configured fallback policy and a fresh user turn can recover', async kind => {
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
    const uid = `model-recovery-${kind}`;
    users.activateUser(uid);
    const primary = await auth.addCustomModelEntry({ baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' });
    const fallback = await auth.addCustomModelEntry({ baseUrl: 'https://fallback.invalid/v1', model: 'fallback-model', apiKey: 'fixture-fallback' });
    await auth.reorderEntries([primary.entryId, fallback.entryId]);
    const history: Message[] = [{ role: 'user', turnId: 1, content: [
      { type: 'text', text: 'earlier image' }, { type: 'image', mediaType: 'image/png', data: 'cGl4ZWxz' },
    ] }, { role: 'assistant', turnId: 1, content: [{ type: 'text', text: 'earlier answer' }] }];
    const original = structuredClone(history);
    const requests: any[] = [];
    const fetchStub = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain(kind === 'rate-limit' && requests.length === 1 ? 'fallback.invalid' : 'example.invalid');
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) return new Response(JSON.stringify({ error: {
        message: kind === 'unsupported-image' ? 'This model does not support image inputs.' : 'Too many requests',
        type: kind === 'unsupported-image' ? 'invalid_request_error' : 'rate_limit_error',
      } }), { status: kind === 'unsupported-image' ? 400 : 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } });
      return success();
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const build = () => buildRunner({ userId: uid, sessionId: `gconv-${uid}`, resumeActiveTurn: true,
        userMessage: 'text-only follow-up', conversationHistory: { source: 'fixture-history', messages: history } });
      const first = await build();
      const events: any[] = [];
      for await (const event of first.runner.runStream({ message: 'inspect image', images: [{ data: 'cGl4ZWxz', mediaType: 'image/png' }] })) events.push(event);
      expect(requests).toHaveLength(kind === 'rate-limit' ? 2 : 1);
      expect(JSON.stringify(requests[0])).toContain('image_url');
      expect(events.some(event => event.type === 'retry')).toBe(false);
      if (kind === 'rate-limit') expect(events.at(-1)).toMatchObject({ type: 'done', result: { text: 'recovered' } });
      else expect(events.at(-1)).toMatchObject({ type: 'done', result: { meta: { error: { statusCode: 400 } } } });
      const next = await build();
      const result = await next.runner.run({ message: 'inspect image', resumeActiveTurn: true });
      expect(result.text).toBe('recovered');
      expect(requests).toHaveLength(kind === 'rate-limit' ? 3 : 2);
      if (kind === 'unsupported-image') expect(JSON.stringify(requests[1])).not.toContain('image_url');
      else expect(JSON.stringify(requests[1])).toContain('image_url');
      expect(history).toEqual(original);
      expect(JSON.stringify(next.failureTrackingScope.getMessages())).toContain('cGl4ZWxz');
    } finally { vi.unstubAllGlobals(); }
  });
});
