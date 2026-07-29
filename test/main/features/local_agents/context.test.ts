import { describe, expect, it } from 'vitest';

import {
  buildCliDurableInstructions,
  buildCliRecoveryContext,
  buildCliTurnPrompt,
  createCliContextPlan,
  isCliResumeRejectedMessage,
  materializeCliContext,
} from '../../../../src/main/features/local_agents/context';

const XML_PROTOCOL = [
  '## Output protocol — switching project directory',
  '<agent-input-form>',
  '{"agent_id":"agent-1","fields":[{"id":"project_dir","type":"directory"}]}',
  '</agent-input-form>',
].join('\n');

function plan() {
  return createCliContextPlan({
    durableInstructions: buildCliDurableInstructions({
      agentName: 'Orkas Codex',
      workflow: 'Implement and verify changes in the current project.',
      codingProtocol: XML_PROTOCOL,
      projectInstructions: '## Project instructions (user-authored)\n\nKeep public APIs stable.',
      language: 'zh',
    }),
    turnPrompt: buildCliTurnPrompt({ task: '修复登录失败' }),
    recoveryContext: buildCliRecoveryContext({
      historyLines: ['[user → agent-1] 前面已经定位到 auth.ts'],
    }),
  });
}

describe('local_agents/context › semantic CLI context', () => {
  it.each([
    ['claude', 'native', 'invocation'],
    ['codex', 'native', 'session'],
    ['opencode', 'user-message', 'session'],
    ['openclaw', 'user-message', 'session'],
    ['hermes', 'user-message', 'invocation'],
  ] as const)(
    'materializes fresh and resumed %s context from its %s/%s capability',
    (cli, channel, scope) => {
      const contextPlan = plan();
      const fresh = materializeCliContext(contextPlan, { cli, resumed: false });
      const resumed = materializeCliContext(contextPlan, { cli, resumed: true });

      expect(fresh.prompt).toContain('## Conversation context recovered by Orkas');
      expect(fresh.prompt).toContain('auth.ts');
      expect(fresh.prompt).toContain('修复登录失败');
      expect(fresh.resumeFallbackPrompt).toContain('Conversation context recovered');

      if (channel === 'native') {
        expect(fresh.systemPrompt).toContain('You are "Orkas Codex".');
        expect(fresh.systemPrompt).toContain('## Workflow');
        expect(fresh.systemPrompt).toContain(XML_PROTOCOL);
        expect(fresh.systemPrompt).toContain('## Project instructions (user-authored)');
        expect(fresh.systemPrompt).toContain('## Response language');
        expect(fresh.prompt).not.toContain('You are "Orkas Codex".');
        expect(resumed.systemPrompt).toBe(fresh.systemPrompt);
      } else {
        expect(fresh.systemPrompt).toBeUndefined();
        expect(fresh.prompt).toContain('You are "Orkas Codex".');
        expect(fresh.prompt).toContain(XML_PROTOCOL);
        expect(resumed.systemPrompt).toBeUndefined();
      }

      if (scope === 'session') {
        expect(resumed.prompt).toBe('修复登录失败');
        expect(resumed.prompt).not.toContain('<agent-input-form>');
        expect(resumed.prompt).not.toContain('Conversation context recovered');
      } else if (cli === 'claude') {
        // Claude receives invocation-scoped durable instructions through its
        // native channel, so the user turn remains current-task-only.
        expect(resumed.prompt).toBe('修复登录失败');
        expect(resumed.systemPrompt).toContain(XML_PROTOCOL);
      } else {
        // Hermes declares resume=none. Even a stray resumed=true input must
        // fail closed to a fresh bootstrap with bounded visible recovery.
        expect(resumed.prompt).toContain('You are "Orkas Codex".');
        expect(resumed.prompt).toContain('Conversation context recovered');
        expect(resumed.prompt).toContain('修复登录失败');
      }
    },
  );

  it('keeps a recovery payload ready if a resumed user-message session is rejected', () => {
    const contextPlan = plan();
    const resumed = materializeCliContext(contextPlan, { cli: 'opencode', resumed: true });

    expect(resumed.prompt).toBe('修复登录失败');
    expect(resumed.resumeFallbackPrompt).toContain(XML_PROTOCOL);
    expect(resumed.resumeFallbackPrompt).toContain('Conversation context recovered');
  });

  it('caps recovery independently of durable instructions and keeps newest history', () => {
    const recovery = buildCliRecoveryContext({
      historyLines: [
        `old ${'x'.repeat(1500)}`,
        `new ${'y'.repeat(700)}`,
      ],
      maxBytes: 1200,
    });

    expect(Buffer.byteLength(recovery, 'utf8')).toBeLessThanOrEqual(1200);
    expect(recovery).toContain('new ');
    expect(recovery).not.toContain('old ');
    expect(recovery).toContain('older entries omitted');
  });

  it('includes historical attachment paths in the same hard recovery cap', () => {
    const recovery = buildCliRecoveryContext({
      historyLines: ['newest useful task'],
      attachmentPaths: Array.from(
        { length: 30 },
        (_, index) => `/tmp/${index}-${'attachment'.repeat(12)}.txt`,
      ),
      maxBytes: 1100,
    });

    expect(Buffer.byteLength(recovery, 'utf8')).toBeLessThanOrEqual(1100);
    expect(recovery).toContain('newest useful task');
    expect(recovery).toContain('## Earlier attachments (older paths omitted)');
    expect(recovery).toContain('/tmp/29-');
    expect(recovery).not.toContain('/tmp/0-');
  });

  it('keeps a plain turn byte-small when no dynamic protocol or attachment exists', () => {
    expect(buildCliTurnPrompt({ task: '继续' })).toBe('继续');
    expect(buildCliTurnPrompt({
      task: '检查附件',
      attachmentPaths: ['/tmp/a.txt', '/tmp/a.txt'],
    })).toBe('## Attachments\n- /tmp/a.txt\n\n## Your task\n\n检查附件');
  });

  it('does not add a wrapper around native slash commands', () => {
    const contextPlan = createCliContextPlan({
      durableInstructions: 'durable',
      turnPrompt: '/compact',
      recoveryContext: 'old context',
      passthrough: true,
    });
    const materialized = materializeCliContext(contextPlan, { cli: 'claude', resumed: true });

    expect(materialized.prompt).toBe('/compact');
    expect(materialized.systemPrompt).toBe('durable');
    expect(materialized.resumeFallbackPrompt).toBe('/compact');
  });

  it('recognizes stale-session failures without matching ordinary task errors', () => {
    expect(isCliResumeRejectedMessage('No conversation found with session ID abc')).toBe(true);
    expect(isCliResumeRejectedMessage('session does not exist')).toBe(true);
    expect(isCliResumeRejectedMessage('unknown session abc')).toBe(true);
    expect(isCliResumeRejectedMessage('tests failed in session-manager.ts')).toBe(false);
  });
});
