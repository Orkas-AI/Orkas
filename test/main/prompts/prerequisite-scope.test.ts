import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptManager } from '../../../src/main/prompts/loader';
import { composeChatPrompt } from '../../../src/main/prompts/chat_prompt_composer';
import { buildCliDurableInstructions } from '../../../src/main/features/local_agents/context';

describe('required precondition and independent-work boundary', () => {
  it('owns the rule once and carries it through both chat roles and CLI instructions', () => {
    const prompts = new PromptManager(path.resolve(process.cwd(), 'src/main/prompts'));
    const intent = prompts.load('chat_user_intent_rules');
    // Source ownership only; actual model adherence is evaluated by the
    // registered tool-capable cases, never inferred from these assertions.
    expect(intent).toMatch(/honor explicit stop instructions/i);
    expect(intent).toMatch(/Continue authorized work independent of unmet prerequisites/i);
    expect(intent).toMatch(/safety or reversibility does not waive them/i);
    expect(intent).not.toContain('complete the safe remainder');
    for (const role of ['chat_commander', 'chat_agent_in_group']) {
      const main = prompts.load(role);
      expect(main).not.toContain('safety or reversibility does not waive');
      const composed = composeChatPrompt({ main, stableFragments: [intent], languageDirective: 'LANG', runtimeDatetimeBlock: 'DATE' });
      expect(composed.split(intent)).toHaveLength(2);
      expect(composed.indexOf(intent)).toBeLessThan(composed.indexOf('## Runtime injection'));
    }
    const cli = buildCliDurableInstructions({ agentName: 'Developer', intentRules: intent, workflow: 'Repair the requested module.', language: 'en' });
    expect(cli.split(intent)).toHaveLength(2);
    expect(cli.indexOf(intent)).toBeLessThan(cli.indexOf('## Workflow'));
  });

});
