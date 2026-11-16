import { AgentRunner } from '../../src/core-agent/src/agent/runner';
import { createConfig } from '../../src/core-agent/src/config/loader';
import { ProviderRegistry } from '../../src/core-agent/src/providers/registry';
import type { AgentTool } from '../../src/core-agent/src/tools/base';
import { createProgrammaticToolPolicy } from '../../src/main/model/core-agent/programmatic-tool-policy';

/** Script only the provider proposal; execute real registered tools, policy,
 * VM, callbacks and Session commitment without a model/network dependency. */
export async function runProgramWithTools(tools: AgentTool[], code: string, workingDir: string, userId = 'u1') {
  const requests: any[] = [];
  let round = 0;
  const provider: any = {
    id: 'program-delivery-fixture', name: 'Scripted no-network provider',
    async complete() { throw Error('Unexpected auxiliary model request'); },
    async *stream(request: any) {
      requests.push(structuredClone(request));
      yield { type: 'message_start' };
      yield { type: 'message_end', model: 'fixture', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: round === 0 ? 'tool_use' : 'end_turn',
        content: round++ === 0
          ? [{ type: 'tool_use', id: 'program-delivery', name: 'run_program', input: { code } }]
          : [{ type: 'text', text: 'The requested files are ready for review.' }],
      };
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry(); providers.registerFactory(provider.id, () => provider);
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: provider.id, defaultModel: 'fixture', maxToolLoops: 3 } }),
    providers, tools, evolution: { enabled: false }, programmaticToolPolicy: createProgrammaticToolPolicy({ userId }),
  });
  let receipt: { content: string; isError?: boolean } | undefined;
  for await (const event of runner.runStream({ message: 'Prepare the requested deliverables.', workingDir })) {
    if (event.type === 'tool_end' && event.name === 'run_program') receipt = { content: event.result, isError: event.isError };
  }
  if (!receipt) throw Error('Missing program receipt');
  return { ...receipt, requests, session: runner.getSession() };
}
