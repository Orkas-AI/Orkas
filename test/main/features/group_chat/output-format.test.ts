import { describe, it, expect } from 'vitest';

import {
  _buildOutputFormatHintForTest,
  _buildInputChannelBlocksForTest,
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
  it('keeps the selected turn language after an English-authored agent workflow', async () => {
    const prompt = await _buildAgentInGroupSystemPromptForTest({
      agent_id: 'language-contract-agent',
      name: 'LanguageContractAgent',
      description_zh: '仅中文运行说明',
      description_en: 'ENGLISH_DESCRIPTION_SHOULD_NOT_RENDER',
      workflow: 'This workflow is intentionally authored in English.',
    }, '/tmp/language-contract-agent', 'zh');

    expect(prompt).toContain('仅中文运行说明');
    expect(prompt).not.toContain('ENGLISH_DESCRIPTION_SHOULD_NOT_RENDER');
    expect(prompt).toContain('User UI language: **Chinese (简体中文)**');
    expect(prompt.lastIndexOf('## User language'))
      .toBeGreaterThan(prompt.lastIndexOf('## Runtime injection'));
    expect(prompt.lastIndexOf('## User language'))
      .toBeGreaterThan(prompt.lastIndexOf('This workflow is intentionally authored in English.'));
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
      expect(hint).toContain('automatic output layout');
      expect(hint).toContain('Use plain text or Markdown');
      expect(hint).toContain('Use `:::dashboard`');
      expect(hint).toContain('valid fenced `:::dashboard` JSON block');
      expect(hint).toContain('Use `create_artifact` only');
      expect(hint).toContain('operate the result');
      expect(hint).toContain('Respect explicit user constraints');
    }
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
    expect(hint).toMatch(/Run your own Information sufficiency check/i);
    expect(hint).toMatch(/output only/i);
    expect(hint).toMatch(/one `<agent-input-form>`/i);
    expect(hint).toMatch(/Required open shape/i);
    expect(hint).toContain('<plan-interaction status="open" />');
    expect(hint).toMatch(/at most 2-3 focused fields/i);
    expect(hint).toMatch(/recommendation, diagnosis, plan, report/i);
    expect(hint).toMatch(/form fields are the questions/i);
  });

  it('keeps the pause protocol for a prose-channel agent but asks in plain language', () => {
    // The pause signal is the plan-interaction marker, which every consumer
    // accepts on its own (`!!form || planInteraction === 'open'`), so a
    // formless agent still pauses a plan step correctly.
    const hint = _buildPlanInteractionHintForTest(true, 'prose');
    expect(hint).toContain('### Plan interaction');
    expect(hint).toContain('<plan-interaction status="open" />');
    expect(hint).toMatch(/at most 2-3 focused questions in plain prose/i);
    expect(hint).not.toMatch(/agent-input-form/i);
  });
});

describe('group_chat agent input-channel prompt blocks', () => {
  it('renders the platform default byte-identical to the pre-template text', () => {
    // Nine agents minus one keep the form mandate; any drift here silently
    // rewrites every default agent's asking protocol.
    const blocks = _buildInputChannelBlocksForTest('form');
    expect(blocks.ask_channel_rule).toBe(
      'Ask for the smallest useful missing set (at most 2-3 focused fields) via `<agent-input-form>` and stop.',
    );
    expect(blocks.need_input_rule).toBe(
      'If you need user input, send an `<agent-input-form>` and stop; do not wait in prose.',
    );
    expect(blocks.input_channel_protocol).toContain('### Form protocol (only input channel)');
    expect(blocks.input_channel_protocol).toContain('Plain text questions, numbered lists, and "please confirm/tell me" prose are not input channels.');
    expect(blocks.input_channel_protocol).toContain('### Form lifecycle');
    expect(blocks.input_channel_protocol).toContain('Do not replace a form with a "need these details" section.');
  });

  it('teaches a prose-channel agent to ask in plain language and never emit the form tag', () => {
    // The 2026-08-05 evening regression: VideoStudio's skill forbade forms
    // while this platform prompt mandated them, and the model followed the
    // platform. The prose channel removes the contradiction at its source.
    const blocks = _buildInputChannelBlocksForTest('prose');
    expect(blocks.ask_channel_rule).toMatch(/in plain prose and stop/i);
    expect(blocks.need_input_rule).toMatch(/ordinary message is the input channel/i);
    expect(blocks.input_channel_protocol).toContain('### Input channel (plain prose)');
    expect(blocks.input_channel_protocol).toMatch(/retired protocol, not an example/i);
    // The tag may appear only inside "never emit" phrasing — every mention
    // must be a prohibition, and none of the form-mandate sentences survive.
    for (const value of Object.values(blocks)) {
      for (const line of value.split('\n')) {
        if (line.includes('<agent-input-form>')) {
          expect(line, line).toMatch(/never emit/i);
        }
      }
    }
    expect(JSON.stringify(blocks)).not.toContain('only input channel');
    expect(JSON.stringify(blocks)).not.toContain('are not input channels');
  });
});
