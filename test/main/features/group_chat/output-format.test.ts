import { describe, it, expect } from 'vitest';

import {
  _buildOutputFormatHintForTest,
  _buildPlanInteractionHintForTest,
} from '../../../../src/main/features/group_chat/bus';
import { prompts } from '../../../../src/main/prompts/loader';

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

describe('group_chat CLI output_format prompt hints', () => {
  it('renders no presentation hints or dashboard schema', () => {
    const rendered = prompts.load('chat_cli_agent', {
      agent_name: 'CliAgent',
      agent_description: 'Runs local CLI tasks.',
      output_protocol_block: '',
      language_block: '## User language\n\nUser UI language: **English**.',
      attachments_block: '',
      conversation_block: '',
      task_body: 'Summarize status.',
      runtime_datetime_block: '## Current date\n\nTimezone: Asia/Shanghai\nCurrent date: 2026-06-05',
    });

    expect(rendered).not.toContain('Use plain text or Markdown');
    expect(rendered).not.toContain('automatic output layout');
    expect(rendered).not.toContain('### Dashboard format');
    expect(rendered).not.toContain(':::dashboard');
    expect(rendered).not.toContain('create_artifact');
    expect(rendered).not.toMatch(/\$output_[A-Za-z0-9_]+/);
  });

  it('includes the language directive in CLI prompts', () => {
    const rendered = prompts.load('chat_cli_agent', {
      agent_name: 'CliAgent',
      agent_description: 'Runs local CLI tasks.',
      output_protocol_block: '',
      language_block: '## User language\n\nUser UI language: **Simplified Chinese**. Write all human-readable prose in Simplified Chinese.',
      attachments_block: '',
      conversation_block: '',
      task_body: 'Summarize status.',
      runtime_datetime_block: '## Current date\n\nTimezone: Asia/Shanghai\nCurrent date: 2026-06-05',
    });

    expect(rendered).toContain('## User language');
    expect(rendered).toContain('Write all human-readable prose in Simplified Chinese');
    expect(rendered.indexOf('## Runtime injection')).toBeLessThan(rendered.indexOf('## User language'));
    expect(rendered).toContain('## Current date');
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
});
