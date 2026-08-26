import { describe, it, expect } from 'vitest';
import {
  resumeConsumedTheTurn,
  runUsageTokens,
} from '../../../../src/main/features/local_agents/runner';

/** Scenario: the user sends a message to a CLI agent whose previous session was
 *  interrupted — the app was killed, the process crashed, a background run was
 *  cut short. The CLI resumes onto that half-written session, spends the turn
 *  digesting it, and ends without ever calling the model. The message went in
 *  and nothing came back; the host reported "the model returned nothing" and
 *  the message was gone.
 *
 *  Resending is the recovery, so the cost of a false positive is the agent
 *  answering the same thing twice, and the cost of a false negative is losing
 *  what the user said. The predicate is therefore built around the one signal
 *  that cannot be produced by an ordinary quiet turn: zero usage.
 */
const consumed = {
  attemptedResume: true,
  status: 'completed',
  outputChars: 0,
  usageTokens: 0,
  sawBackgroundStopped: true,
};

describe('local_agents/runner › resumeConsumedTheTurn', () => {
  it('recognises a resumed turn that answered nothing and never called the model', () => {
    expect(resumeConsumedTheTurn(consumed)).toBe(true);
  });

  // The discriminator. A model that read the room and stayed silent still
  // burned tokens; resending would make it answer twice.
  it('leaves a quiet turn alone when the model actually ran', () => {
    expect(resumeConsumedTheTurn({ ...consumed, usageTokens: 12 })).toBe(false);
  });

  it('leaves a turn that said something alone', () => {
    expect(resumeConsumedTheTurn({ ...consumed, outputChars: 1 })).toBe(false);
  });

  // A fresh session has no interrupted state to digest, so an empty turn there
  // is a real empty turn and must reach the user as one.
  it('never resends a turn that did not resume a session', () => {
    expect(resumeConsumedTheTurn({ ...consumed, attemptedResume: false })).toBe(false);
  });

  // Without the stop record this is indistinguishable from a turn that failed
  // to produce anything for its own reasons.
  it('requires the recovery stop record rather than guessing from emptiness', () => {
    expect(resumeConsumedTheTurn({ ...consumed, sawBackgroundStopped: false })).toBe(false);
  });

  it('leaves failed, cancelled and timed-out turns to their own reporting', () => {
    for (const status of ['failed', 'cancelled', 'timeout', 'missing_cli', undefined]) {
      expect(resumeConsumedTheTurn({ ...consumed, status })).toBe(false);
    }
  });
});

describe('local_agents/runner › runUsageTokens', () => {
  it('sums the token fields a run reports', () => {
    expect(runUsageTokens({ input: 2, output: 11, cacheRead: 40, cacheCreate: 1 })).toBe(54);
  });

  it('reads a genuinely free turn as zero', () => {
    expect(runUsageTokens({ input: 0, output: 0, cost: 0 })).toBe(0);
  });

  // Unknown usage must not read as "the model never ran", or a turn whose
  // accounting the backend simply does not report would be resent every time.
  it('treats unreadable usage as spent rather than as proof the model idled', () => {
    expect(runUsageTokens(undefined)).toBe(1);
    expect(runUsageTokens(null)).toBe(1);
    expect(runUsageTokens({ something: 'else' })).toBe(1);
    // A cost-only row that shows real spend must not read as a free turn.
    expect(runUsageTokens({ cost: 0.5 })).toBe(1);
    expect(resumeConsumedTheTurn({ ...consumed, usageTokens: runUsageTokens({ something: 'else' }) }))
      .toBe(false);
  });

  it('ignores malformed numbers instead of propagating NaN', () => {
    expect(runUsageTokens({ input: 'lots', output: 3 })).toBe(3);
    expect(runUsageTokens({ input: -5, output: 3 })).toBe(3);
  });
});
