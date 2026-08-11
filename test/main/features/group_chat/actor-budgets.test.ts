import { describe, it, expect } from 'vitest';

import { createConfig } from '../../../../src/core-agent/src/config';
import {
  elapsedConvergenceMsForActor,
  maxToolLoopsForActorKind,
  COMMANDER_MAX_TOOL_LOOPS,
  AGENT_MAX_TOOL_LOOPS,
  OFFICE_WORKER_AGENT_ID,
  OFFICE_WORKER_ELAPSED_CONVERGENCE_MS,
} from '../../../../src/main/features/group_chat/actor-budgets';

// These values pin the per-turn tool-round budgets and deliberately cross-check
// the core-agent schema default so the two policies cannot silently diverge.
describe('actor-budgets › maxToolLoopsForActorKind', () => {
  it('gives the commander a raised orchestration budget (120)', () => {
    expect(maxToolLoopsForActorKind('commander')).toBe(COMMANDER_MAX_TOOL_LOOPS);
    expect(COMMANDER_MAX_TOOL_LOOPS).toBe(120);
  });

  it('pins named agent workers to the current 100-round production budget', () => {
    expect(maxToolLoopsForActorKind('agent')).toBe(AGENT_MAX_TOOL_LOOPS);
    expect(AGENT_MAX_TOOL_LOOPS).toBe(100);
    expect(AGENT_MAX_TOOL_LOOPS).toBe(createConfig().agent.maxToolLoops);
  });

  it('leaves ephemeral workers and users on the 100-round core-agent schema default', () => {
    expect(createConfig().agent.maxToolLoops).toBe(100);
    expect(maxToolLoopsForActorKind('worker')).toBeUndefined();
    expect(maxToolLoopsForActorKind('user')).toBeUndefined();
  });
});

describe('actor-budgets › elapsedConvergenceMsForActor', () => {
  it('gives only OfficeWorker the three-minute soft convergence checkpoint', () => {
    expect(elapsedConvergenceMsForActor('agent', OFFICE_WORKER_AGENT_ID))
      .toBe(OFFICE_WORKER_ELAPSED_CONVERGENCE_MS);
    expect(OFFICE_WORKER_ELAPSED_CONVERGENCE_MS).toBe(3 * 60 * 1000);
    expect(elapsedConvergenceMsForActor('agent', 'another-agent')).toBeUndefined();
  });

  it('does not override non-agent actor kinds even if the id matches', () => {
    expect(elapsedConvergenceMsForActor('commander', OFFICE_WORKER_AGENT_ID)).toBeUndefined();
    expect(elapsedConvergenceMsForActor('worker', OFFICE_WORKER_AGENT_ID)).toBeUndefined();
    expect(elapsedConvergenceMsForActor('user', OFFICE_WORKER_AGENT_ID)).toBeUndefined();
  });
});
