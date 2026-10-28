import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiProvider } from '../src/providers/pi-provider.js';
import type { CompletionParams } from '../src/providers/base.js';
import * as zlib from 'node:zlib';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRunner } from '../src/agent/runner.js';
import { PersistentSession } from '../src/agent/persistent-session.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { createConfig } from '../src/config/loader.js';
import { defineTool } from '../src/tools/base.js';

const token = (account: string) => `fixture.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: account },
})).toString('base64')}.fixture`;
const request = (sessionId: string): CompletionParams => ({
  model: 'gpt-6.1-sol', sessionId, cacheRetention: 'long',
  systemPrompt: 'Stable reference',
  messages: [{ role: 'user', content: [{ type: 'text', text: `Private input for ${sessionId}` }] }],
});
function response() {
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
    id: 'fixture', status: 'completed', output: [],
    usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
  } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.unstubAllGlobals());

async function wirePayload(input: RequestInfo | URL, init?: RequestInit): Promise<any> {
  const wire = new Request(input, init);
  const bytes = Buffer.from(await wire.arrayBuffer());
  return JSON.parse((wire.headers.get('content-encoding') === 'zstd'
    ? zlib.zstdDecompressSync(bytes) : bytes).toString('utf8'));
}

describe('Codex cache affinity without shared conversation state', () => {
  it.each(['complete', 'stream'] as const)('enforces user ownership after an async payload hook and on the actual wire (%s)', async method => {
    const captures: Array<{ body: any; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      captures.push({ body: await wirePayload(input, init), headers: new Headers(init?.headers) });
      return response();
    }));
    const p = createPiProvider({ provider: 'openai-codex', model: 'gpt-6.1-sol', apiKey: token('shared'),
      userCacheKey: 'opaque-user-a',
      onPayload: async payload => ({ ...(payload as object), prompt_cache_key: 'foreign-hook-key' }),
    });
    const params = request('chat-a'), before = JSON.stringify(params);
    if (method === 'complete') await p.complete(params);
    else for await (const e of p.stream(params)) if (e.type === 'error') throw e.error;
    expect(captures).toHaveLength(1);
    expect(captures[0].body.prompt_cache_key).toBe('opaque-user-a');
    expect(captures[0].headers.get('session-id')).toBe('opaque-user-a');
    expect(captures[0].headers.get('x-client-request-id')).toBe('chat-a');
    expect(JSON.stringify(captures[0].body)).not.toContain('foreign-hook-key');
    expect(JSON.stringify(params)).toBe(before);
  });

  it('keeps two parallel tool sessions and their reloaded receipts isolated under one shared SID', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-affinity-isolation-'));
    const traces: Array<{ chat: string; body: any; headers: Headers }> = [];
    const rounds = new Map<string, number>(), executed: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const body = await wirePayload(input, init), headers = new Headers(init?.headers);
      const chat = headers.get('x-client-request-id')!;
      expect(['chat-a', 'chat-b']).toContain(chat);
      const marker = chat === 'chat-a' ? 'MARKER_ALPHA' : 'MARKER_BETA';
      const foreign = chat === 'chat-a' ? 'MARKER_BETA' : 'MARKER_ALPHA';
      expect(JSON.stringify(body.input)).toContain(marker);
      expect(JSON.stringify(body.input)).not.toContain(foreign);
      const round = (rounds.get(chat) ?? 0) + 1;
      rounds.set(chat, round); traces.push({ chat, body, headers });
      const item = round === 1
        ? { type: 'function_call', id: `fc_${chat}`, call_id: `call_${chat}`, name: 'record_fixture',
            arguments: JSON.stringify({ marker }), status: 'completed' }
        : { type: 'message', id: `msg_${chat}_${round}`, role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Recorded.', annotations: [] }] };
      const events: any[] = [{ type: 'response.created', response: { id: `resp_${chat}_${round}`, output: [], status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: round === 1 ? { ...item, arguments: '' } : { ...item, content: [] } }];
      if (round === 1) events.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments });
      else events.push({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Recorded.' });
      events.push({ type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `resp_${chat}_${round}`, status: 'completed', output: [item],
          usage: { input_tokens: 100, output_tokens: 5 } } });
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': `route-${chat}` } });
    }));
    const build = (chat: string) => {
      const session = new PersistentSession({ sessionFile: path.join(dir, `${chat}.jsonl`) });
      const providers = new ProviderRegistry();
      providers.registerFactory('openai-codex', () => createPiProvider({ provider: 'openai-codex', model: 'gpt-6.1-sol',
        apiKey: token('shared'), userCacheKey: 'opaque-user-a' }));
      return new AgentRunner({ config: createConfig({ agent: { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', maxRetries: 0 } }),
        providers, session, evolution: { enabled: false }, tools: [defineTool({ name: 'record_fixture',
          description: 'Record the supplied fixture marker.', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] },
          execute: async args => { const marker = (args as { marker: string }).marker; executed.push(marker); return { content: `receipt:${marker}` }; },
        })] });
    };
    try {
      const first = await Promise.all([build('chat-a').run({ message: 'Record MARKER_ALPHA.' }),
        build('chat-b').run({ message: 'Record MARKER_BETA.' })]);
      expect(first.every(result => !result.meta.error)).toBe(true);
      expect(executed.sort()).toEqual(['MARKER_ALPHA', 'MARKER_BETA']);
      for (const [chat, marker, foreign] of [['chat-a', 'MARKER_ALPHA', 'MARKER_BETA'], ['chat-b', 'MARKER_BETA', 'MARKER_ALPHA']]) {
        const stored = fs.readFileSync(path.join(dir, `${chat}.jsonl`), 'utf8');
        expect(stored).toContain(`receipt:${marker}`);
        expect(stored).not.toContain(foreign);
        const resumed = await build(chat).run({ message: 'Continue after reopening.' });
        expect(resumed.meta.error).toBeUndefined();
      }
      expect(executed).toHaveLength(2);
      expect(traces).toHaveLength(6);
      expect(traces.every(t => t.headers.get('session-id') === 'opaque-user-a'
        && t.body.prompt_cache_key === 'opaque-user-a')).toBe(true);
      for (const chat of ['chat-a', 'chat-b']) expect(traces.filter(t => t.chat === chat)
        .map(t => t.headers.get('x-codex-turn-state'))).toEqual([null, `route-${chat}`, null]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['complete', 'stream'] as const)('keeps affinity across new chats while preserving private payloads and request identity (%s)', async method => {
    const headers: Headers[] = [];
    const payloads: any[] = [];
    const signals: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      headers.push(new Headers(init.headers)); signals.push(init.signal);
      return response();
    }));
    const config = { provider: 'openai-codex', model: 'gpt-6.1-sol', apiKey: token('a'), userCacheKey: 'opaque-user-a',
      headers: { 'X-Fixture': 'preserved' },
      onPayload: (value: unknown) => { payloads.push(structuredClone(value)); },
    };
    const build = () => createPiProvider(config);
    const controller = new AbortController();
    const a = { ...request('chat-a'), signal: controller.signal };
    const b = { ...request('chat-b'), reasoning: 'low' as const, signal: controller.signal };
    const before = JSON.stringify([a, b]);
    for (const params of [a, b, a]) {
      if (method === 'complete') await build().complete(params);
      else for await (const event of build().stream(params)) if (event.type === 'error') throw event.error;
    }
    const affinity = headers[0].get('session-id');
    expect(typeof affinity).toBe('string');
    expect(affinity!.length).toBeGreaterThan(0);
    expect(affinity!.length).toBeLessThanOrEqual(64);
    expect(affinity).not.toBe('chat-a');
    expect(headers.map(h => h.get('session-id'))).toEqual([affinity, affinity, affinity]);
    expect(headers.map(h => h.get('x-client-request-id'))).toEqual(['chat-a', 'chat-b', 'chat-a']);
    expect(headers.every(h => h.get('authorization') === `Bearer ${token('a')}`
      && h.get('chatgpt-account-id') === 'a' && h.get('x-fixture') === 'preserved')).toBe(true);
    expect(payloads.map(p => p.prompt_cache_key)).toEqual([affinity, affinity, affinity]);
    expect(JSON.stringify(payloads[0])).not.toContain('chat-b');
    expect(JSON.stringify(payloads[1])).not.toContain('chat-a');
    expect(JSON.stringify([a, b])).toBe(before);
    expect(signals.every(Boolean)).toBe(true);
  });

  it('keeps one user stable across credential refresh and model changes but isolates users sharing a credential', async () => {
    const headers: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => { headers.push(new Headers(init.headers)); return response(); }));
    for (const [userCacheKey, account, model, baseUrl] of [
      ['opaque-user-a', 'shared', 'gpt-6.1-sol', undefined],
      ['opaque-user-b', 'shared', 'gpt-6.1-sol', undefined],
      ['opaque-user-a', 'refreshed', 'gpt-6-sol', undefined],
      ['opaque-user-a', 'shared', 'gpt-6.1-sol', 'https://fixture.invalid/backend-api'],
    ] as const) {
      const config = { provider: 'openai-codex', model, apiKey: token(account), baseUrl, userCacheKey };
      await createPiProvider(config).complete({ ...request('same-chat'), model });
    }
    const keys = headers.map(h => h.get('session-id'));
    expect(keys).toEqual(['opaque-user-a', 'opaque-user-b', 'opaque-user-a', 'opaque-user-a']);
    expect(keys.every(key => key && !key.includes('same-chat') && !key.includes(token('a')))).toBe(true);
  });

  it('retains per-chat SDK identity when no user mapping is available', async () => {
    const headers: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => { headers.push(new Headers(init.headers)); return response(); }));
    const p = createPiProvider({ provider: 'openai-codex', model: 'gpt-6.1-sol', apiKey: token('shared') });
    await p.complete(request('chat-a'));
    await p.complete(request('chat-b'));
    expect(headers.map(h => h.get('session-id'))).toEqual(['chat-a', 'chat-b']);
  });

  it('cancels only its own concurrent chat and retries without changing the user mapping', async () => {
    const headers: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      headers.push(new Headers(init.headers));
      if (headers.length === 1) return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Fixture cancellation', 'AbortError')), { once: true });
      });
      return response();
    }));
    const config = { provider: 'openai-codex', model: 'gpt-6.1-sol', apiKey: token('a'), userCacheKey: 'opaque-user-a' };
    const p = createPiProvider(config), abort = new AbortController();
    const pending = p.complete({ ...request('chat-a'), signal: abort.signal, onRequestFailure() {} });
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(headers).toHaveLength(1));
    await p.complete(request('chat-b'));
    abort.abort();
    await rejected;
    await p.complete(request('chat-a'));
    expect(headers.map(h => h.get('session-id'))).toEqual(Array(3).fill('opaque-user-a'));
    expect(headers.map(h => h.get('x-client-request-id'))).toEqual(['chat-a', 'chat-b', 'chat-a']);
  });

  it('does not add affinity to calls without a session or caching explicitly disabled', async () => {
    const headers: Headers[] = [];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      headers.push(new Headers(init?.headers)); bodies.push(await wirePayload(input, init)); return response();
    }));
    const config = { provider: 'openai-codex', model: 'gpt-6.1-sol', apiKey: token('a'), userCacheKey: 'opaque-user-a' };
    const p = createPiProvider(config);
    await p.complete({ ...request('unused'), sessionId: undefined });
    await p.complete({ ...request('disabled'), cacheRetention: 'none' });
    expect(headers.map(h => h.get('session-id'))).toEqual([null, null]);
    expect(bodies.map(body => body.prompt_cache_key)).toEqual([undefined, undefined]);
  });

  it.each((['complete', 'stream'] as const).flatMap(method => (['static', 'dynamic'] as const).map(source => [method, source] as const)))
  ('maps Responses cache identity without replacing mixed-case %s/%s authentication headers', async (method, source) => {
    const headers: Headers[] = [], payloads: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => { headers.push(new Headers(init.headers)); return response(); }));
    for (const sessionId of ['chat-a', 'chat-b']) {
      const config = { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'fixture', userCacheKey: 'opaque-user-a',
        ...(source === 'static' ? { headers: { SeSsIoN_Id: 'login-credential' } }
          : { requestHeaders: () => ({ SeSsIoN_Id: 'login-credential' }) }),
        onPayload: (value: unknown) => { payloads.push(structuredClone(value)); } };
      const p = createPiProvider(config);
      if (method === 'complete') await p.complete(request(sessionId));
      else for await (const event of p.stream(request(sessionId))) if (event.type === 'error') throw event.error;
    }
    expect(payloads.map(p => p.prompt_cache_key)).toEqual(['opaque-user-a', 'opaque-user-a']);
    expect(headers.map(h => h.get('session_id'))).toEqual(['login-credential', 'login-credential']);
    expect(headers.map(h => h.get('x-client-request-id'))).toEqual(['chat-a', 'chat-b']);
  });

  it('preserves other protocols and their caller-supplied headers', async () => {
    const headers: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => { headers.push(new Headers(init.headers)); return response(); }));
    await createPiProvider({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'fixture',
      headers: { 'session-id': 'caller-owned' },
    }).complete(request('openai-chat'));
    expect(headers[0].get('session-id')).toBe('caller-owned');
  });
});
