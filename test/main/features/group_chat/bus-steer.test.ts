import { describe, it, expect } from 'vitest';
import { drainSteerInto } from '../../../../src/main/features/group_chat/bus';

/**
 * Unit test for interrupt-steer's queue drain (G9). `drainSteerInto` decides
 * which pending FIFO items get folded into the running turn vs. left to run as
 * their own follow-up turns. The fold rule: text-only USER messages aimed at
 * the running actor. Everything else (dispatches, other actors, attachments,
 * nested sub-runs) stays queued.
 */

type AnyItem = Record<string, any>;
function item(o: AnyItem): AnyItem {
  return { turnId: 't', msgId: 'm', ...o };
}
function fakeW(queue: AnyItem[]): any {
  return { cid: 'cid1', queue };
}
const commander = { kind: 'commander', id: 'commander', name: 'Commander' } as any;
const agentX = { kind: 'agent', id: 'agentX', name: 'X' };
const agentY = { kind: 'agent', id: 'agentY', name: 'Y' };

describe('group_chat bus › drainSteerInto (interrupt-steer)', () => {
  it('folds text-only user messages for the running actor, in FIFO order, leaving the rest', () => {
    const w = fakeW([
      item({ actor: commander, fromActorId: 'user', llmPayload: 'U1' }),                       // fold
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'DISPATCH' }),               // not user → keep
      item({ actor: commander, fromActorId: 'user', llmPayload: 'U2' }),                       // fold
      item({ actor: agentY, fromActorId: 'user', llmPayload: 'OTHER_ACTOR' }),                 // other actor → keep
      item({ actor: commander, fromActorId: 'user', llmPayload: 'HAS_ATT', attachments: ['a.pdf'] }), // attachments → keep
      item({ actor: commander, fromActorId: 'user', llmPayload: 'NESTED', nested: true }),     // nested → keep
    ]);

    const folded = drainSteerInto(w, commander);

    expect(folded).toEqual(['U1', 'U2']);
    expect(w.queue.map((q: AnyItem) => q.llmPayload)).toEqual(['DISPATCH', 'OTHER_ACTOR', 'HAS_ATT', 'NESTED']);
  });

  it('returns [] and leaves the queue intact when nothing matches the running actor', () => {
    const w = fakeW([
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'DISPATCH' }),
      item({ actor: agentY, fromActorId: 'user', llmPayload: 'OTHER_ACTOR' }),
    ]);
    expect(drainSteerInto(w, commander)).toEqual([]);
    expect(w.queue.length).toBe(2);
  });

  it('drains all matching messages even when interleaved with non-matching ones', () => {
    const w = fakeW([
      item({ actor: commander, fromActorId: 'user', llmPayload: 'A' }),
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'D1' }),
      item({ actor: commander, fromActorId: 'user', llmPayload: 'B' }),
      item({ actor: agentX, fromActorId: 'commander', llmPayload: 'D2' }),
      item({ actor: commander, fromActorId: 'user', llmPayload: 'C' }),
    ]);
    expect(drainSteerInto(w, commander)).toEqual(['A', 'B', 'C']);
    expect(w.queue.map((q: AnyItem) => q.llmPayload)).toEqual(['D1', 'D2']);
  });
});
