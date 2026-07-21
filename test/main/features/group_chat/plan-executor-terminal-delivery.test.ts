import { describe, expect, it } from 'vitest';
import { onTurnFinished, type TurnFinishedEvent } from '../../../../src/main/features/group_chat/plan_executor';

function commanderEvent(overrides: Partial<TurnFinishedEvent> = {}): TurnFinishedEvent {
  return {
    actor: { id: 'commander', kind: 'commander' },
    finalText: '',
    errText: 'empty response',
    aborted: false,
    produced: [],
    activityEvents: 8,
    ...overrides,
  };
}

describe('group_chat plan executor terminal delivery', () => {
  it('keeps a successful hand_off_to empty tail silent', async () => {
    await expect(onTurnFinished('u1', 'c1', commanderEvent({ terminalDelivery: true })))
      .resolves.toEqual({ kind: 'silent' });
  });

  it('still persists an ordinary tool-only commander turn', async () => {
    await expect(onTurnFinished('u1', 'c1', commanderEvent()))
      .resolves.toEqual({ kind: 'persist', text: '' });
  });

  it('does not hide a user-facing side effect from a terminal-delivery turn', async () => {
    await expect(onTurnFinished('u1', 'c1', commanderEvent({
      terminalDelivery: true,
      errText: null,
      produced: ['/tmp/final.pdf'],
    }))).resolves.toEqual({
      kind: 'persist',
      text: '',
      produced: ['/tmp/final.pdf'],
    });
  });

  it('preserves structured config failure metadata on the error bubble', async () => {
    const outcome = await onTurnFinished('u1', 'c1', commanderEvent({
      errText: 'No model configured',
      activityEvents: 0,
      failureKind: 'config',
      failureCode: 'model_preflight',
    }));

    expect(outcome).toMatchObject({
      kind: 'persist',
      failureKind: 'config',
      failureCode: 'model_preflight',
    });
    expect(outcome.kind === 'persist' ? outcome.text : '').toContain('No model configured');
  });

  it('renders an external CLI dependency error without a model-failure wrapper', async () => {
    const message = '⚠️ Agent “Hermes” cannot run: its version could not be identified.';
    const outcome = await onTurnFinished('u1', 'c1', commanderEvent({
      actor: { id: 'hermes', kind: 'agent' },
      errText: message,
      activityEvents: 0,
      failureKind: 'dependency',
      failureCode: 'version_unknown',
    }));

    expect(outcome).toMatchObject({
      kind: 'persist',
      failureKind: 'dependency',
      failureCode: 'version_unknown',
    });
    const text = outcome.kind === 'persist' ? outcome.text : '';
    expect(text).toContain(message);
    expect(text).not.toContain('Model call failed');
    expect(text.match(/⚠️/g)).toHaveLength(1);
  });

  it('labels a local agent runtime error as an agent run failure', async () => {
    const outcome = await onTurnFinished('u1', 'c1', commanderEvent({
      actor: { id: 'hermes', kind: 'agent' },
      errText: 'ACP handshake failed',
      activityEvents: 0,
      failureKind: 'runtime',
      failureCode: 'cli_failed',
    }));

    const text = outcome.kind === 'persist' ? outcome.text : '';
    expect(text).toContain('Agent run failed');
    expect(text).toContain('ACP handshake failed');
    expect(text).not.toContain('Model call failed');
  });

  it('preserves host validation metadata alongside partial assistant text', async () => {
    await expect(onTurnFinished('u1', 'c1', commanderEvent({
      finalText: 'Draft created.\n\n<span style="color:var(--danger)">Rejected invalid skill file.</span>',
      errText: null,
      failureKind: 'validation',
      failureCode: 'skill_mutation_rejected',
    }))).resolves.toMatchObject({
      kind: 'persist',
      failureKind: 'validation',
      failureCode: 'skill_mutation_rejected',
    });
  });
});
