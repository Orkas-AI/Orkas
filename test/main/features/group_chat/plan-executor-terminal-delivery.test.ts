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
});
