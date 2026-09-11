import { describe, it, expect } from 'vitest';

import {
  _buildOutputFormatHintForTest,
  _buildInputChannelProtocolForTest,
  _buildAgentInGroupSystemPromptForTest,
  _buildPlanInteractionHintForTest,
  _redactDispatchToolResult,
  _resolveAgentInputsForRuntimeForTest,
} from '../../../../src/main/features/group_chat/bus';
import {
  buildCliDurableInstructions,
  buildCliTurnPrompt,
} from '../../../../src/main/features/local_agents/context';

describe('group-chat response language', () => {
  it('keeps prompt-internal descriptions in English while user language outranks the Chinese UI fallback', async () => {
    const prompt = await _buildAgentInGroupSystemPromptForTest({
      agent_id: 'language-contract-agent',
      name: 'LanguageContractAgent',
      description_zh: '仅中文运行说明',
      description_en: 'ENGLISH_DESCRIPTION_SHOULD_NOT_RENDER',
      workflow: 'This workflow is intentionally authored in English.',
    }, '/tmp/language-contract-agent', 'zh');

    expect(prompt).toContain('ENGLISH_DESCRIPTION_SHOULD_NOT_RENDER');
    expect(prompt).not.toContain('仅中文运行说明');
    expect(prompt).toContain('Fallback UI language: **Chinese (简体中文)**');
    expect(prompt).toContain('a current explicit user language request');
    expect(prompt).toContain("the clear language of the user's latest substantive prose");
    expect(prompt).toContain('Write all human-readable prose in the chosen language');
    expect(prompt.lastIndexOf('## User language'))
      .toBeGreaterThan(prompt.lastIndexOf('## Runtime injection'));
    expect(prompt.lastIndexOf('## User language'))
      .toBeGreaterThan(prompt.lastIndexOf('This workflow is intentionally authored in English.'));
  });
});

describe('named Agent execution ownership', () => {
  it('keeps current-task execution with the Agent without advertising the disabled Plan', async () => {
    const prompt = await _buildAgentInGroupSystemPromptForTest({
      agent_id: 'execution-owner-agent',
      name: 'ExecutionOwnerAgent',
      workflow: 'Complete the assigned work and verify the result.',
    }, '/tmp/execution-owner-agent', 'en');

    const ownership = prompt.indexOf('The bus/commander owns cross-actor orchestration;');
    expect(ownership).toBeGreaterThanOrEqual(0);
    expect(prompt).toContain('you own execution of the current task.');
    expect(prompt).toContain('one or two sentences when appropriate');
    expect(prompt).toContain('These updates are not final replies');
    expect(prompt).toContain('Complete the authorized scope');
    expect(prompt).not.toContain('Once you output, your turn is done.');
    expect(prompt).not.toContain('facts/conclusions only');
    expect(prompt).not.toContain('before the first tool call');
    expect(prompt.match(/These updates are not final replies/g)).toHaveLength(1);
    expect(prompt.indexOf('These updates are not final replies')).toBeLessThan(prompt.indexOf('## Runtime injection'));
    expect(prompt).not.toContain('Plan/upstream/downstream state belongs to the bus/commander.');
    expect(prompt).not.toMatch(/current-task execution Plan|Use an execution Plan|manage_execution_plan/i);
  });
});

describe('named Agent prompt stability', () => {
  it('keeps the concrete working directory only in the runtime injection', async () => {
    const agent = {
      agent_id: 'stable-prefix-agent',
      name: 'StablePrefixAgent',
      workflow: 'Complete the assigned work.',
    };
    const first = await _buildAgentInGroupSystemPromptForTest(
      agent,
      '/tmp/orkas-agent-workspace-a',
      'en',
    );
    const second = await _buildAgentInGroupSystemPromptForTest(
      agent,
      '/tmp/orkas-agent-workspace-b',
      'en',
    );
    const marker = '## Runtime injection';
    const firstMarker = first.indexOf(marker);
    const secondMarker = second.indexOf(marker);

    expect(firstMarker).toBeGreaterThanOrEqual(0);
    expect(secondMarker).toBeGreaterThanOrEqual(0);
    expect(first.slice(0, firstMarker)).toBe(second.slice(0, secondMarker));
    expect(first.slice(0, firstMarker)).not.toContain('/tmp/orkas-agent-workspace-a');
    expect(second.slice(0, secondMarker)).not.toContain('/tmp/orkas-agent-workspace-b');
    expect(first.slice(firstMarker)).toContain('Tool cwd and default write location = `/tmp/orkas-agent-workspace-a`');
    expect(second.slice(secondMarker)).toContain('Tool cwd and default write location = `/tmp/orkas-agent-workspace-b`');
    expect(first.match(/\/tmp\/orkas-agent-workspace-a/g)).toHaveLength(1);
    expect(second.match(/\/tmp\/orkas-agent-workspace-b/g)).toHaveLength(1);
  });
});

describe('named Agent tool-surface ownership', () => {
  it('leaves tool activation mechanics to the runtime tool contract', async () => {
    const prompt = await _buildAgentInGroupSystemPromptForTest({
      agent_id: 'tool-surface-agent',
      name: 'ToolSurfaceAgent',
      workflow: 'Complete the assigned work with the available capabilities.',
    }, '/tmp/tool-surface-agent', 'en');

    expect(prompt).not.toContain('Tools are auto-registered');
    expect(prompt).not.toContain('`read_files` / `bash` / `library` / `web_search` / `create_pdf`');
    expect(prompt).not.toContain('`tool_load`');
    expect(prompt).toContain('its read-and-invoke contract is authoritative');
    expect(prompt).toContain('use its `list_connector_tools` → `call_connector_tool` flow');
  });
});

describe('dispatch tool-result redaction in the process rail', () => {
  // Assert the worker OUTPUT is gone (robust to the i18n'd replacement wording),
  // not an exact replacement string.
  it('scrubs a dispatch tool result (run_worker / dispatch_to) on end', () => {
    for (const name of ['run_worker', 'dispatch_to']) {
      const inner = { stream: 'tool', data: { name, phase: 'end', result_preview: '<worker-result>secret worker output</worker-result>' } };
      _redactDispatchToolResult(inner);
      expect(inner.data.result_preview, `${name} output must be removed`).not.toContain('secret worker output');
      expect(inner.data.result_preview).not.toContain('<worker-result>');
      expect(inner.data.result_preview, `${name} keeps a short note`).toBeTruthy();
    }
  });

  it('also handles the `result` phase + toolName/status field aliases', () => {
    const inner = { stream: 'tool', data: { toolName: 'dispatch_to', status: 'result', result_preview: 'raw worker text' } };
    _redactDispatchToolResult(inner as unknown);
    expect((inner.data as { result_preview: string }).result_preview).not.toContain('raw worker text');
  });

  it('leaves NON-dispatch tools untouched (read_file end keeps its preview)', () => {
    const inner = { stream: 'tool', data: { name: 'read_file', phase: 'end', result_preview: 'file contents preview' } };
    _redactDispatchToolResult(inner);
    expect(inner.data.result_preview).toBe('file contents preview');
  });

  it('leaves the dispatch tool START event untouched (only end carries the result)', () => {
    const inner = { stream: 'tool', data: { name: 'run_worker', phase: 'start', arguments: { task: 'do a thing' } } };
    _redactDispatchToolResult(inner);
    expect((inner.data as { result_preview?: string }).result_preview).toBeUndefined();
    expect(inner.data.arguments).toEqual({ task: 'do a thing' });
  });

  it('ignores non-tool streams and malformed events', () => {
    const a = { stream: 'lifecycle', data: { phase: 'end', result_preview: 'x' } };
    _redactDispatchToolResult(a);
    expect(a.data.result_preview).toBe('x');
    expect(() => _redactDispatchToolResult(undefined)).not.toThrow();
    expect(() => _redactDispatchToolResult({})).not.toThrow();
  });
});

describe('group_chat output_format prompt hints', () => {
  it('turns auto, missing, and unknown values into the automatic chooser', () => {
    for (const value of ['auto', undefined, 'future-mode']) {
      const hint = _buildOutputFormatHintForTest(value);

      expect(hint).toContain('### Presentation preference');
      expect(hint).not.toContain('### Output format');
      expect(hint).toMatch(/Automatic layout/i);
      expect(hint).toContain('text/Markdown');
      expect(hint).toContain('`:::dashboard` for static structured snapshots');
      expect(hint).toContain('`create_artifact` only for user-operated results');
      expect(hint).toMatch(/explicit user constraints win/i);
      expect(hint.length).toBeLessThanOrEqual(300);
    }
  });

  it('assembles the output selector before the shared format grammar', async () => {
    const prompt = await _buildAgentInGroupSystemPromptForTest({
      agent_id: 'output-contract-agent',
      name: 'OutputContractAgent',
      workflow: 'Return the requested result.',
      output_format: 'auto',
    }, '/tmp/output-contract-agent', 'en');

    const selector = prompt.indexOf('### Presentation preference');
    const grammar = prompt.indexOf('## Output formats');
    expect(selector).toBeGreaterThanOrEqual(0);
    expect(grammar).toBeGreaterThan(selector);
    expect(prompt.match(/Automatic layout:/g)).toHaveLength(1);
    expect(prompt).toContain('{"schema_version":1,"root":{"type":"Stack"');
  });

  it('turns text and its legacy alias into a hard standard-reply instruction', () => {
    for (const value of ['text', 'markdown_only']) {
      const hint = _buildOutputFormatHintForTest(value);

      expect(hint).toContain('### Presentation preference');
      expect(hint).not.toContain('### Output format');
      expect(hint).toContain('standard reply output');
      expect(hint).toContain('plain text or Markdown');
      expect(hint).toContain('NOT emit `:::dashboard`');
      expect(hint).toContain('or call `create_artifact`');
    }
  });

  it('turns dashboard into dashboard-preferred and artifact-blocked instructions', () => {
    const hint = _buildOutputFormatHintForTest('dashboard');

    expect(hint).toContain('### Presentation preference');
    expect(hint).not.toContain('### Output format');
    expect(hint).toContain('dashboard output');
    expect(hint).toContain('read-only structured snapshots');
    expect(hint).toContain('Follow the `Output formats` schema exactly');
    expect(hint).toContain('NOT call `create_artifact`');
  });

  it('allows artifacts for both the current value and legacy alias', () => {
    for (const value of ['artifact', 'allow_artifacts']) {
      const hint = _buildOutputFormatHintForTest(value);

      expect(hint).toContain('### Presentation preference');
      expect(hint).not.toContain('### Output format');
      expect(hint).toContain('allow interactive apps');
      expect(hint).toContain('static/read-only structured snapshots');
      expect(hint).toContain('create_artifact');
      expect(hint).not.toContain('do NOT call `create_artifact`');
    }
  });

});

describe('VideoStudio runtime language input', () => {
  const inputs = [{
    id: 'language',
    type: 'select',
    default: 'en',
    default_by_ui_language: {
      zh: 'zh-CN',
      en: 'en',
      ja: 'ja',
      pt: 'pt-BR',
    },
    options: [
      { value: 'en', label: 'English' },
      { value: 'zh-CN', label: '简体中文' },
      { value: 'ja', label: '日本語' },
      { value: 'pt-BR', label: 'Português (Brasil)' },
    ],
  }];

  it.each([
    ['zh-CN', 'zh-CN'],
    ['en-US', 'en'],
    ['ja-JP', 'ja'],
    ['pt-BR', 'pt-BR'],
    ['unsupported', 'en'],
    [undefined, 'en'],
  ])('maps user UI language %s to video default %s', (uiLanguage, expected) => {
    const [language] = _resolveAgentInputsForRuntimeForTest(inputs, uiLanguage);
    expect(language.default).toBe(expected);
    expect(language.options.map((option: { value: string }) => option.value)).toEqual(
      expect.arrayContaining(['en', 'zh-CN', 'ja', 'pt-BR']),
    );
  });

  it('does not rewrite inputs without a UI-language mapping or mutate the persisted schema', () => {
    const plainInputs = [{ id: 'tone', type: 'select', default: 'formal' }];
    const resolved = _resolveAgentInputsForRuntimeForTest(plainInputs, 'zh');
    expect(resolved[0]).toBe(plainInputs[0]);
    expect(inputs[0].default).toBe('en');
  });
});

describe('group_chat CLI output_format prompt hints', () => {
  it('adds no presentation hints or dashboard schema to CLI context', () => {
    const rendered = [
      buildCliDurableInstructions({
        agentName: 'CliAgent',
        workflow: 'Run local CLI tasks.',
        language: 'en',
      }),
      buildCliTurnPrompt({ task: 'Summarize status.' }),
    ].join('\n\n');

    expect(rendered).not.toContain('Use plain text or Markdown');
    expect(rendered).not.toContain('automatic output layout');
    expect(rendered).not.toContain('### Dashboard format');
    expect(rendered).not.toContain(':::dashboard');
    expect(rendered).not.toContain('create_artifact');
    expect(rendered).not.toMatch(/\$output_[A-Za-z0-9_]+/);
  });

  it('keeps only a compact language directive in durable CLI instructions', () => {
    const durable = buildCliDurableInstructions({
      agentName: 'CliAgent',
      workflow: 'Run local CLI tasks.',
      language: 'zh',
    });

    expect(durable).toContain('## Response language');
    expect(durable).toContain('Chinese (简体中文)');
    expect(durable).not.toContain('## Runtime injection');
    expect(durable).not.toContain('## Current date');
  });
});

describe('group_chat plan interaction prompt hints', () => {
  it('keeps non-interactive agents free of plan interaction instructions', () => {
    expect(_buildPlanInteractionHintForTest(false)).toBe('');
  });

  it('tells interactive agents when to open plan interaction', () => {
    const hint = _buildPlanInteractionHintForTest(true);

    expect(hint).toContain('### Plan interaction');
    expect(hint).toMatch(/insufficient-input reply contains only/i);
    expect(hint).toMatch(/required internal result marker/i);
    expect(hint).toMatch(/channel-specific input request above/i);
    expect(hint).toContain('<plan-interaction status="open" />');
    expect(hint).toMatch(/recommendation, diagnosis, plan, report/i);
    expect(hint).toContain('<plan-interaction status="closed" />');
  });

  it('keeps the pause protocol for a prose-channel agent without teaching a form mandate', async () => {
    // The pause signal is the plan-interaction marker, which every consumer
    // accepts on its own (`!!form || planInteraction === 'open'`), so a
    // formless agent still pauses a plan step correctly.
    const prompt = await _buildAgentInGroupSystemPromptForTest({
      agent_id: 'prose-input-agent',
      name: 'ProseInputAgent',
      workflow: 'Work interactively with the user.',
      interactive: true,
      input_channel: 'prose',
    }, '/tmp/prose-input-agent', 'en');
    expect(prompt).toContain('### Plan interaction');
    expect(prompt).toContain('<plan-interaction status="open" />');
    expect(prompt).toMatch(/at most 2-3 focused fields or questions/i);
    expect(prompt).not.toMatch(/output exactly one `<agent-input-form>`/i);
  });
});

describe('group_chat agent input-channel prompt blocks', () => {
  it('renders one compact platform-default form shape', () => {
    const protocol = _buildInputChannelProtocolForTest('form');
    expect(protocol).toContain('### Input channel: form');
    expect(protocol).toContain('Plain-text questions, numbered question lists, and "please confirm/tell me" prose are not input channels.');
    expect(protocol).toContain('Prefer one plain question in a field label');
    expect(protocol).toContain('use multiple fields only for distinct typed values');
    expect(protocol).toContain('Do not replace the form with a "need these details" section.');
    expect(protocol).not.toMatch(/at most 2-3|repeat the input decision|and stop/i);
    expect(protocol.match(/<agent-input-form>/g)).toHaveLength(2);
  });

  it('teaches a prose-channel agent to ask in plain language and never emit the form tag', () => {
    // The 2026-08-05 evening regression: VideoStudio's skill forbade forms
    // while this platform prompt mandated them, and the model followed the
    // platform. The prose channel removes the contradiction at its source.
    const protocol = _buildInputChannelProtocolForTest('prose');
    expect(protocol).toContain('### Input channel: plain prose');
    expect(protocol).toMatch(/ask directly in plain language/i);
    expect(protocol).toMatch(/retired protocol, not an example/i);
    expect(protocol).not.toMatch(/at most 2-3|repeat the input decision|and stop/i);
    // The tag may appear only inside "never emit" phrasing — every mention
    // must be a prohibition, and none of the form-mandate sentences survive.
    for (const line of protocol.split('\n')) {
      if (line.includes('<agent-input-form>')) {
        expect(line, line).toMatch(/never emit/i);
      }
    }
    expect(protocol).not.toContain('are not input channels');
  });

  it('assembles schema extraction, sufficiency, asking, and retry as one ordered flow', async () => {
    const prompt = await _buildAgentInGroupSystemPromptForTest({
      agent_id: 'input-flow-agent',
      name: 'InputFlowAgent',
      workflow: 'Write a launch brief from declared inputs.',
      inputs: [
        { id: 'product', label: 'Product', type: 'text', required: true },
        { id: 'audience', label: 'Audience', type: 'text', required: true },
      ],
    }, '/tmp/input-flow-agent', 'en');

    expect(prompt.match(/## Input decision and channel/g)).toHaveLength(1);
    expect(prompt).toContain('"id":"product"');
    expect(prompt).toContain('"id":"audience"');
    expect(prompt).not.toContain('## Information sufficiency');
    expect(prompt).not.toContain('### Handling `inputs_schema`');
    expect(prompt).toMatch(/1\. If `inputs_schema`[\s\S]+2\. Make your own sufficiency decision[\s\S]+3\. If required inputs and context are sufficient[\s\S]+4\. Otherwise request only the smallest useful missing set/);
    expect(prompt.indexOf('### Input channel: form'))
      .toBeGreaterThan(prompt.indexOf('4. Otherwise request only the smallest useful missing set'));
    expect(prompt).toContain('After a user reply or `<agent-input-submission>`, repeat this same decision');
    expect(prompt).not.toMatch(/\$(?:ask_channel_rule|need_input_rule|input_channel_protocol|plan_interaction_hint)/);
  });
});
