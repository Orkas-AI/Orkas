import { describe, expect, it } from 'vitest';
import { lifecycleRecoveryPlan, scoreCancellationCanary } from '../../../../scripts/local-agent-lifecycle.mjs';
import { LOCAL_CLI_CAPABILITIES } from '../../../../src/main/features/local_agents/registry';

// Independent failure controls: a cancellation status alone cannot prove that
// a tool was running, its descendants stopped, or native continuation worked.
const complete = {
  started: true, fixtureUnchanged: true, cancelled: true, terminalCount: 1,
  terminalLast: true, persistedCancelled: true, childExited: true,
  observedPastDeadline: true, lateEffectAbsent: true, sessionPresent: true,
  resumed: true, sessionStrategyHonored: true, recoveredKey: true, recoveryPersisted: true,
  recoveryTerminalCount: 1, recoveryTerminalLast: true, recoveryToolsAppropriate: true,
  recoveryStreamed: true, recoveryOutputPersisted: true,
  logsHealthy: true, warmupReady: true,
};

describe('real CLI cancellation canary acceptance', () => {
  it.each([
    ['claude', 'native', true], ['codex', 'native', true], ['opencode', 'native', true],
    ['hermes', 'fresh', false], ['openclaw', 'session-id', true],
  ] as const)('uses the actual %s continuity contract instead of excluding the adapter', (cli, mode, warmup) => {
    expect(lifecycleRecoveryPlan(LOCAL_CLI_CAPABILITIES[cli])).toEqual({ mode, warmup });
  });

  it('accepts a stopped live tool followed by a persisted native-session recovery', () => {
    expect(scoreCancellationCanary(complete).every(check => check.pass)).toBe(true);
  });

  it.each(Object.keys(complete))('rejects incomplete cancellation/recovery evidence: %s', key => {
    const invalid = { ...complete, [key]: typeof complete[key as keyof typeof complete] === 'number' ? 2 : false };
    expect(scoreCancellationCanary(invalid).every(check => check.pass)).toBe(false);
  });

  it('fails closed on absent evidence rather than treating an unstarted tool as cancelled', () => {
    expect(scoreCancellationCanary({}).every(check => check.pass)).toBe(false);
  });

  it('requires the authoritative wall-timeout status in events and reopened metadata', () => {
    const timedOut = { ...complete, cancelled: false, persistedCancelled: false,
      timedOut: true, persistedTimeout: true, timeoutKindCorrect: true };
    expect(scoreCancellationCanary(timedOut, 'wall').every(check => check.pass)).toBe(true);
    for (const key of ['timedOut', 'persistedTimeout', 'timeoutKindCorrect', 'childExited', 'lateEffectAbsent', 'recoveredKey']) {
      expect(scoreCancellationCanary({ ...timedOut, [key]: false }, 'wall').every(check => check.pass)).toBe(false);
    }
    expect(() => scoreCancellationCanary(timedOut, 'idle')).toThrow(/unsupported/);
  });
});
