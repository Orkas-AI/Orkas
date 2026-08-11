import { describe, expect, it } from 'vitest';

import {
  CLI_HISTORY_MAX_MESSAGE_BYTES,
  CLI_HISTORY_MAX_TURNS,
  CLI_RECOVERY_MAX_BYTES,
  buildCliDurableInstructions,
  buildCliConversationContext,
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
    recoveryContext: buildCliConversationContext({
      mode: 'recovery',
      turns: [{ id: '1', messages: ['[user → agent-1] 前面已经定位到 auth.ts'] }],
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

  it('adds only the canonical delta before the current task on a resume', () => {
    const contextPlan = createCliContextPlan({
      durableInstructions: 'durable',
      recoveryContext: 'FULL_HISTORY_MUST_ONLY_BE_FALLBACK',
      incrementalContext: buildCliConversationContext({
        mode: 'incremental',
        turns: [{ id: '8', messages: ['NEW_CANONICAL_MESSAGE'] }],
      }),
      turnPrompt: 'CURRENT_TASK',
    });
    const resumed = materializeCliContext(contextPlan, { cli: 'codex', resumed: true });

    expect(resumed.prompt).toContain('Conversation updates since the previous CLI turn');
    expect(resumed.prompt).toContain('NEW_CANONICAL_MESSAGE');
    expect(resumed.prompt).toContain('CURRENT_TASK');
    expect(resumed.prompt).not.toContain('FULL_HISTORY_MUST_ONLY_BE_FALLBACK');
    expect(resumed.resumeFallbackPrompt).toContain('FULL_HISTORY_MUST_ONLY_BE_FALLBACK');
  });

  it('bounds canonical CLI history by complete turn count, total bytes, and single-message bytes', () => {
    const context = buildCliConversationContext({
      mode: 'recovery',
      turns: Array.from({ length: 25 }, (_, index) => ({
        id: String(index + 1),
        messages: [`turn-${index + 1} ${index === 24 ? 'z'.repeat(20_000) : 'short'}`],
      })),
      maxBytes: 4096,
      maxTurns: 20,
      maxMessageBytes: 1024,
    });

    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(4096);
    expect(context).toContain('turn-25');
    expect(context).toContain('message truncated by Orkas');
    expect(context).not.toContain('turn-1 ');
    expect(context).toMatch(/older turns? omitted/);
  });

  it('enforces the production CLI history limits without overriding test budgets', () => {
    expect(CLI_HISTORY_MAX_TURNS).toBe(20);
    expect(CLI_RECOVERY_MAX_BYTES).toBe(16 * 1024);
    expect(CLI_HISTORY_MAX_MESSAGE_BYTES).toBe(8 * 1024);

    const context = buildCliConversationContext({
      mode: 'recovery',
      turns: Array.from({ length: 25 }, (_, index) => ({
        id: String(index + 1),
        messages: [index === 24
          ? `NEWEST_DEFAULT_LIMIT_FACT=violet-orbit\n${'界'.repeat(6_000)}`
          : `DEFAULT_LIMIT_TURN_${String(index + 1).padStart(2, '0')} ${'x'.repeat(900)}`],
      })),
    });

    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(CLI_RECOVERY_MAX_BYTES);
    expect((context.match(/^### Turn /gm) || []).length).toBeLessThanOrEqual(CLI_HISTORY_MAX_TURNS);
    expect(context).toContain('NEWEST_DEFAULT_LIMIT_FACT=violet-orbit');
    expect(context).toContain('message truncated by Orkas');
    expect(context).toMatch(/older turns? omitted/);
    expect(context).not.toContain('DEFAULT_LIMIT_TURN_01');
    expect(context).not.toContain('\uFFFD');
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
