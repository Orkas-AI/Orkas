import { it, expect, vi } from 'vitest';
import { createPiProvider, AgentRunner, ProviderRegistry, createConfig } from '#core-agent';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';
import { _clearAll, getCooldown } from '../../../../src/main/model/core-agent/profile-cooldown';

// Recovery portfolio: a known length stop must remain distinguishable from
// unknown emptiness. Compare the native Runner seam with its configured entry.
// No network, model, tools, or private account state is used.
for (const api of ['openai-completions', 'openai-responses'] as const) {
  for (const shape of ['empty', 'text', 'thinking', 'repeated-empty'] as const) {
    for (const wrapped of [false, true]) {
      it(`${api}/${shape}/${wrapped ? 'configured' : 'direct'}`, async () => {
        _clearAll();
        let requests = 0;
        const emitted: string[] = [];
        const fallbackBuild = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => {
          requests++;
          if (requests > 4) throw new Error('Synthetic request budget exceeded');
          const truncated = requests === 1 || shape === 'repeated-empty';
          const text = truncated ? shape === 'text' ? 'Partial explanation.' : '' : 'Recovered.';
          const reasoning = truncated && shape === 'thinking' ? 'Synthetic reasoning.' : '';
          if (api === 'openai-completions') {
            return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
              delta: { role: 'assistant', ...(text ? { content: text } : {}),
                ...(reasoning ? { reasoning_content: reasoning } : {}) },
              finish_reason: truncated ? 'length' : 'stop',
            }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } });
          }
          const output: any[] = [];
          if (reasoning) output.push({ type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: reasoning }] });
          if (text) output.push({ type: 'message', id: 'msg_fixture', role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }] });
          const events: any[] = output.flatMap((item, output_index) => [
            { type: 'response.output_item.added', output_index, item: { ...item, content: [], summary: [] } },
            ...(item.type === 'reasoning'
              ? [{ type: 'response.reasoning_summary_text.delta', output_index, summary_index: 0, delta: reasoning }]
              : [{ type: 'response.output_text.delta', output_index, delta: text }]),
            { type: 'response.output_item.done', output_index, item },
          ]);
          events.push({ type: truncated ? 'response.incomplete' : 'response.completed', response: {
            id: 'resp_fixture', status: truncated ? 'incomplete' : 'completed', output,
            ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          } });
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } });
        }));
        try {
          const native = createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
            id: 'fixture', name: 'Fixture', provider: 'custom', api, baseUrl: 'https://fixture.invalid/v1',
            reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          } });
          const provider = wrapped ? createRotatingProvider({ providerId: 'custom', networkRetryAttempts: 0,
            candidates: [{ profileId: 'primary', providerId: 'custom', modelId: 'fixture', build: async () => native },
              { profileId: 'fallback', providerId: 'custom', modelId: 'fixture', build: fallbackBuild }],
          }) : native;
          const registry = new ProviderRegistry();
          registry.registerFactory('custom', () => provider);
          const runner = new AgentRunner({ providers: registry,
            config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: 'fixture', maxRetries: 0 } }),
            evolution: { enabled: false }, tools: [],
          });
          let result: any;
          for await (const event of runner.runStream({ message: 'Explain the result.' })) {
            emitted.push(event.type);
            if (event.type === 'done') result = event.result;
          }
          const row = { api, shape, wrapped, requests, text: result?.text,
            error: result?.meta.error, signals: result?.meta.convergenceSignals,
            providerEmpty: emitted.filter(type => type === 'provider_empty').length,
            terminalCount: emitted.filter(type => type === 'done').length,
            cooldown: !!getCooldown('primary'), fallbackBuilds: fallbackBuild.mock.calls.length };
          expect(row.providerEmpty).toBe(0);
          expect(row.fallbackBuilds).toBe(0);
          expect(row.cooldown).toBe(false);
          expect(row.terminalCount).toBe(1);
          expect(result.meta.usage.totalTokens).toBe(shape === 'repeated-empty' ? 80 : 40);
          if (shape === 'repeated-empty') {
            expect(requests).toBe(4);
            expect(result.meta.error?.code).toBe('OUTPUT_LIMIT');
          } else {
            expect(result.meta.error).toBeUndefined();
            expect(requests).toBe(2);
            expect(result.text).toContain('Recovered.');
          }
        } finally { vi.unstubAllGlobals(); _clearAll(); }
      });
    }
  }
}
