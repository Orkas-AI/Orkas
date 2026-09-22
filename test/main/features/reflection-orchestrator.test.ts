import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerMocks.warn,
    error: vi.fn(),
  }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  loggerMocks.warn.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-orchestrator-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.useRealTimers();
  // `loadModuleWithAgents` installs a catalog stub; without this it survives
  // into later tests and silently changes how many agents a cycle sees.
  vi.doUnmock('../../../src/main/features/agents');
  vi.doUnmock('../../../src/main/features/reflection-transcript');
  vi.doUnmock('../../../src/main/model/core-agent/runner');
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return import('../../../src/main/features/reflection-orchestrator');
}

/**
 * Load with the model and transcript stubbed so the *real* reflect path runs.
 * Every other cycle test injects `reflect`, which leaves the write-count →
 * outcome mapping — where the "any reply is a success" defect lived —
 * uncovered.
 */
async function loadModuleWithRunner(opts: {
  writes: number;
  responseText?: string;
  transcriptText?: string;
  /** Reported through `runReflection`'s failure observer before returning. */
  failure?: { kind: string; error?: unknown };
  /** Make `buildRunner` itself throw (no usable model, expired OAuth …). */
  buildRunnerError?: Error;
  inputBudget?: number;
  observeBudget?: (budget: number) => void;
  capacityExceeded?: boolean;
}) {
  vi.resetModules();
  vi.doMock('../../../src/main/features/reflection-transcript', () => ({
    buildTranscript: async (_uid: string, _agent: string, _since: number, budget: number) => {
      opts.observeBudget?.(budget);
      return {
        capacityExceeded: opts.capacityExceeded,
        text: opts.transcriptText ?? 'user did something',
        stats: { convsIncluded: 1, convsConsidered: 2, estimatedTokens: 42 },
      };
    },
    listAgentGmemberFiles: async () => [],
  }));
  vi.doMock('../../../src/main/model/core-agent/runner', () => ({
    buildRunner: async () => {
      if (opts.buildRunnerError) throw opts.buildRunnerError;
      return {
        runner: {
          getReflectionInputBudget: (_fixed: string) => opts.inputBudget ?? 150000,
          runReflection: async (
            _prompt: string,
            _signal?: AbortSignal,
            _sandboxEnv?: Record<string, string>,
            _onModelCall?: unknown,
            onDurableWrite?: () => void,
            onFailure?: (failure: { kind: string; error?: unknown }) => void,
          ) => {
            for (let i = 0; i < opts.writes; i++) onDurableWrite?.();
            if (opts.failure) onFailure?.(opts.failure);
            return opts.responseText ?? 'nothing to save';
          },
        },
      };
    },
  }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  return import('../../../src/main/features/reflection-orchestrator');
}

/** Load with a stubbed agent catalog. The tmp workspace has no agents on
 *  disk, so cycle-ordering behaviour needs more than the `_default` bucket. */
async function loadModuleWithAgents(agentIds: string[]) {
  vi.resetModules();
  vi.doMock('../../../src/main/features/agents', () => ({
    listAgents: async () => agentIds.map((id) => ({ agent_id: id, enabled: true })),
  }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const mod = await import('../../../src/main/features/reflection-orchestrator');
  return mod;
}

function writeReflectionState(uid: string, lastReflectedAt: Record<string, string>): void {
  const dir = path.join(tmpDir, uid, 'local', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reflection-state.json'), JSON.stringify({ lastReflectedAt }));
}

const HOUR = 3600 * 1000;

// ── pickAgentsForCycle ──────────────────────────────────────────────────

describe('reflection-orchestrator › pickAgentsForCycle', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z');

  it('skips agents within cooldown (< 4h since lastReflectedAt)', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: { 'agent-x': new Date(NOW - 2 * 3600 * 1000).toISOString() } };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => true);
    expect(picked.length).toBe(0);
  });

  it('picks dirty agents past cooldown', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: { 'agent-x': new Date(NOW - 6 * 3600 * 1000).toISOString() } };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => true);
    expect(picked.length).toBe(1);
    expect(picked[0].reason).toBe('dirty');
  });

  it('leaves a long-idle agent alone — activity is the only reason to reflect', async () => {
    const mod = await loadModule();
    // Formerly the 7-day max-gap fallback forced this agent in regardless of
    // activity. Its transcript is empty by construction, so it failed every
    // cycle and, because failures never advanced the timestamp, held a cap
    // slot forever against agents that did have activity.
    const stale = new Date(NOW - 30 * 24 * 3600 * 1000).toISOString();
    const state = { lastReflectedAt: { 'agent-x': stale } };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => false);
    expect(picked.length).toBe(0);
  });

  it('treats never-reflected agents as eligible when dirty (default lookback)', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: {} };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => true);
    expect(picked.length).toBe(1);
    expect(picked[0].reason).toBe('never_reflected');
    // sinceMs should be ~48h before now (DEFAULT_LOOKBACK_MS)
    expect(NOW - picked[0].sinceMs).toBeCloseTo(48 * 3600 * 1000, -5);
  });

  it('skips never-reflected agents when not dirty', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: {} };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => false);
    expect(picked.length).toBe(0);
  });

  it('caps at MAX_AGENTS_PER_CYCLE, picking earliest lastReflectedAt first', async () => {
    const mod = await loadModule();
    const lastReflectedAt: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      // agent-0 oldest (NOW - 8h), agent-7 newest just past cooldown (NOW - 4.1h)
      lastReflectedAt[`agent-${i}`] = new Date(NOW - (8 - i * 0.5) * 3600 * 1000).toISOString();
    }
    const ids = Object.keys(lastReflectedAt);
    const picked = await mod.pickAgentsForCycle(TEST_UID, ids, { lastReflectedAt }, NOW, async () => true);
    expect(picked.length).toBe(mod.MAX_AGENTS_PER_CYCLE);
    // First in result should be the oldest (agent-0)
    expect(picked[0].agentId).toBe('agent-0');
  });

  it('a recently failed agent sorts behind never-touched agents and honors its longer cooldown', async () => {
    const mod = await loadModule();
    const state = {
      lastReflectedAt: {},
      lastAttemptAt: { bad: new Date(NOW - 10 * 3600 * 1000).toISOString() },
      failureStreak: { bad: 1 },
    };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['bad', 'fresh'], state, NOW, async () => true);
    // 10h since the failed attempt clears the 8h cooldown, but a touched
    // agent no longer jumps ahead of one that has never had a turn.
    expect(picked.map((p) => p.agentId)).toEqual(['fresh', 'bad']);

    const recent = { ...state, lastAttemptAt: { bad: new Date(NOW - 5 * 3600 * 1000).toISOString() } };
    const pickedRecent = await mod.pickAgentsForCycle(TEST_UID, ['bad', 'fresh'], recent, NOW, async () => true);
    expect(pickedRecent.map((p) => p.agentId)).toEqual(['fresh']);
  });

  it('processes a mix: only past-cooldown dirty agents are picked', async () => {
    const mod = await loadModule();
    const state = {
      lastReflectedAt: {
        'cool':    new Date(NOW - 1 * 3600 * 1000).toISOString(),        // within cooldown
        'dirty':   new Date(NOW - 6 * 3600 * 1000).toISOString(),        // past cooldown, dirty
        'stale':   new Date(NOW - 30 * 24 * 3600 * 1000).toISOString(),  // very old, but idle
        'idle':    new Date(NOW - 6 * 3600 * 1000).toISOString(),        // past cooldown, not dirty
      },
    };
    const isDirty = async (_u: string, id: string) => id === 'dirty';
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['cool', 'dirty', 'stale', 'idle'], state, NOW, isDirty);
    expect(picked.map((p) => p.agentId)).toEqual(['dirty']);
  });

  it('stops catalog checks at a cooperative cancellation point', async () => {
    const mod = await loadModule();
    const controller = new AbortController();
    const checked: string[] = [];
    const picked = await mod.pickAgentsForCycle(
      TEST_UID,
      ['a', 'b', 'c'],
      { lastReflectedAt: {} },
      NOW,
      async (_uid, id) => {
        checked.push(id);
        controller.abort();
        return true;
      },
      controller.signal,
    );

    expect(checked).toEqual(['a']);
    expect(picked.map((row) => row.agentId)).toEqual(['a']);
  });
});

// ── runOneCycle ──────────────────────────────────────────────────────────

describe('reflection-orchestrator › runOneCycle', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z');

  it('returns 0 when no agents are eligible', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => 'reflected' as const);
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => false,
    });
    expect(completed).toBe(0);
    expect(reflect).not.toHaveBeenCalled();
  });

  it('failed reflection does not stamp lastReflectedAt (retry next cycle)', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => { throw new Error('provider down'); });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
    });
    expect(reflect).toHaveBeenCalled();
    expect(completed).toBe(0);
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt).toEqual({});  // no stamp on failure
  });

  it('successful reflection stamps lastReflectedAt with `now`', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => 'reflected' as const);
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
    });
    expect(completed).toBeGreaterThanOrEqual(1);
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBe(new Date(NOW).toISOString());
  });

  it('advances the baseline when the window held no reflectable activity', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => 'nothing_to_reflect' as const);
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
    });

    // Not a reflection, so it is not counted as one …
    expect(completed).toBe(0);
    // … but the window was read and held nothing, so re-reading the same span
    // can only fail the same way. Leaving the baseline was what let idle
    // agents hold every cap slot for 21 consecutive cycles.
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt[mod.DEFAULT_AGENT_ID])
      .toBe(new Date(NOW).toISOString());
  });

  it('an examined-empty agent stops crowding out agents with real activity', async () => {
    const mod = await loadModule();
    const seen: string[] = [];
    const reflect = vi.fn(async (_uid: string, agentId: string) => {
      seen.push(agentId);
      return 'nothing_to_reflect' as const;
    });
    const first = await mod.runOneCycle(TEST_UID, { now: () => NOW, reflect, isDirty: async () => true });
    expect(first).toBe(0);
    expect(seen).toContain(mod.DEFAULT_AGENT_ID);

    // Next cycle within the cooldown: the examined agent is no longer eligible,
    // so its cap slot is free.
    seen.length = 0;
    await mod.runOneCycle(TEST_UID, {
      now: () => NOW + 60_000,
      reflect,
      isDirty: async () => true,
    });
    expect(seen).not.toContain(mod.DEFAULT_AGENT_ID);
  });

  it('a deliberate "nothing to save" consumes the window without counting as a reflection', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => 'nothing_to_save' as const);
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
    });

    // The review prompt asks for this reply when a window holds no new lesson,
    // so it is a healthy outcome — but it wrote nothing, and counting it as a
    // reflection is what made an idle loop look productive.
    expect(completed).toBe(0);
    // The window was read; re-reading it can only reach the same conclusion.
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt[mod.DEFAULT_AGENT_ID])
      .toBe(new Date(NOW).toISOString());
  });

  it('a reply that wrote nothing is not counted as a reflection', async () => {
    // The exact shape observed in production: one model turn, a 15-character
    // "nothing to save", no tool call, meta files untouched — and the cycle
    // reporting a successful reflection.
    const mod = await loadModuleWithRunner({ writes: 0, responseText: 'nothing to save' });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      isDirty: async () => true,
    });
    expect(completed).toBe(0);
    // Still terminal: the window was read, so the baseline advances.
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt[mod.DEFAULT_AGENT_ID])
      .toBe(new Date(NOW).toISOString());
  });

  it('counts a reflection once the model actually writes something', async () => {
    const mod = await loadModuleWithRunner({ writes: 1, responseText: 'updated competence' });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      isDirty: async () => true,
    });
    expect(completed).toBe(1);
  });

  it('treats an empty model response as retryable, not as a consumed window', async () => {
    const mod = await loadModuleWithRunner({ writes: 0, responseText: '' });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      isDirty: async () => true,
    });
    expect(completed).toBe(0);
    // `runReflection` returns '' for provider errors and loop exhaustion, so
    // unlike "nothing to save" this must not consume the window.
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt).toEqual({});
  });

  it('counts durable writes followed by an empty final text as reflected', async () => {
    // Loop exhaustion after the lessons were saved must consume the window;
    // failing it re-ran the same window next cycle and wrote the lessons
    // again (2026-08-28 review E1-6).
    const mod = await loadModuleWithRunner({ writes: 2, responseText: '' });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      isDirty: async () => true,
    });
    expect(completed).toBe(1);
    expect(Object.keys(mod.readReflectionState(TEST_UID).lastReflectedAt)).toHaveLength(1);
  });

  it('one agent exceeding its deadline does not take the rest of the cycle down', async () => {
    const mod = await loadModuleWithAgents(['agent-b']);
    const seen: string[] = [];
    const reflect = vi.fn(async (
      _uid: string,
      agentId: string,
      _sinceMs: number,
      signal?: AbortSignal,
    ) => {
      seen.push(agentId);
      if (agentId === mod.DEFAULT_AGENT_ID) {
        // Hang until this agent's own deadline fires.
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('deadline');
      }
      return 'reflected' as const;
    });

    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
      perAgentTimeoutMs: 20,
      isIdle: () => true,
    });

    // A single cycle-wide budget used to abort the slow agent *and* end the
    // cycle, so the agents behind it were never attempted — and the slow ones
    // are precisely those reading their files and writing an update.
    expect(seen).toEqual([mod.DEFAULT_AGENT_ID, 'agent-b']);
    expect(completed).toBe(1);
    const stamped = mod.readReflectionState(TEST_UID).lastReflectedAt;
    expect(stamped['agent-b']).toBe(new Date(NOW).toISOString());
    expect(stamped[mod.DEFAULT_AGENT_ID]).toBeUndefined();  // failed → retry
  });

  it('defers remaining agents when a task arrives after an agent completed', async () => {
    const mod = await loadModuleWithAgents(['agent-b', 'agent-c']);
    let idle = true;
    const seen: string[] = [];
    const reflect = vi.fn(async (_uid: string, agentId: string) => {
      seen.push(agentId);
      idle = false;
      return 'reflected' as const;
    });

    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
      isIdle: () => idle,
    });

    expect(seen).toEqual([mod.DEFAULT_AGENT_ID]);
    expect(completed).toBe(1);
    // Deferred agents keep their old baseline, so they lead the next cycle.
    const stamped = mod.readReflectionState(TEST_UID).lastReflectedAt;
    expect(stamped['agent-b']).toBeUndefined();
    expect(stamped['agent-c']).toBeUndefined();
  });

  it('does not stamp stale work that resolves after account-switch cancellation', async () => {
    const mod = await loadModule();
    const controller = new AbortController();
    let parentAbortReached = false;
    const reflect = vi.fn(async (
      _uid: string,
      _agentId: string,
      _sinceMs: number,
      signal?: AbortSignal,
    ) => {
      // The per-agent deadline hands down a derived controller, not the cycle
      // signal itself; what has to hold is that cancelling the cycle still
      // reaches the running reflection. Asserting object identity here would
      // be swallowed by the cycle's catch and pass vacuously.
      controller.abort();
      parentAbortReached = signal?.aborted === true;
      return 'reflected' as const;
    });

    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
      signal: controller.signal,
    });

    expect(reflect).toHaveBeenCalledOnce();
    expect(parentAbortReached).toBe(true);
    expect(completed).toBe(0);
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt).toEqual({});
  });

  it('uses the requested account feature gate instead of the currently active account', async () => {
    const preferences = path.join(tmpDir, 'u2', 'cloud', 'config', 'preferences.json');
    fs.mkdirSync(path.dirname(preferences), { recursive: true });
    fs.writeFileSync(preferences, JSON.stringify({ metacognition_enabled: false }));
    const mod = await loadModule();
    const reflect = vi.fn();

    const completed = await mod.runOneCycle('u2', {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
    });

    expect(completed).toBe(0);
    expect(reflect).not.toHaveBeenCalled();
  });

  it('reports the per-agent deadline as timeout and moves on even when the reflection ignores abort', async () => {
    const mod = await loadModuleWithAgents(['agent-b']);
    const seen: string[] = [];
    const reflect = vi.fn(async (_uid: string, agentId: string) => {
      seen.push(agentId);
      // A provider call that never honors the abort signal: the deadline must
      // still hand the slot to the next agent.
      if (agentId === mod.DEFAULT_AGENT_ID) return new Promise<'reflected'>(() => {});
      return 'reflected' as const;
    });

    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
      perAgentTimeoutMs: 20,
      isIdle: () => true,
    });

    expect(seen).toEqual([mod.DEFAULT_AGENT_ID, 'agent-b']);
    expect(completed).toBe(1);
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBeUndefined();   // window kept
    expect(state.lastAttemptAt?.[mod.DEFAULT_AGENT_ID]).toBe(new Date(NOW).toISOString());
    expect(state.failureStreak?.[mod.DEFAULT_AGENT_ID]).toBe(1);
  });

  it('keeps a window whose deadline fired after the lessons were already saved', async () => {
    // The deadline abandons the run rather than waiting for it, so writes that
    // already landed stay on disk. Retrying that window would ask the model to
    // save the same lessons a second time.
    const mod = await loadModule();
    const reflect = vi.fn(async (
      _uid: string, _agentId: string, _sinceMs: number,
      _signal?: AbortSignal, onDurableWrite?: () => void,
    ) => {
      onDurableWrite?.();
      return new Promise<'reflected'>(() => {});
    });

    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
      perAgentTimeoutMs: 20,
      isIdle: () => true,
    });

    expect(completed).toBe(1);
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBe(new Date(NOW).toISOString());
    expect(state.failureStreak?.[mod.DEFAULT_AGENT_ID]).toBeUndefined();
  });

  it('a failed attempt is stamped and the agent waits out a doubled cooldown before retrying', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => { throw new Error('provider down'); });
    const isDirty = async () => true;

    await mod.runOneCycle(TEST_UID, { now: () => NOW, reflect, isDirty });
    expect(reflect).toHaveBeenCalledTimes(1);

    // Past the base 4h cooldown but inside the 8h one a single failure earns.
    await mod.runOneCycle(TEST_UID, { now: () => NOW + 5 * HOUR, reflect, isDirty });
    expect(reflect).toHaveBeenCalledTimes(1);

    await mod.runOneCycle(TEST_UID, { now: () => NOW + 9 * HOUR, reflect, isDirty });
    expect(reflect).toHaveBeenCalledTimes(2);
    expect(mod.readReflectionState(TEST_UID).failureStreak?.[mod.DEFAULT_AGENT_ID]).toBe(2);
  });

  it('gives up the window after MAX_FAILURE_STREAK consecutive failures', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => { throw new Error('provider down'); });
    const isDirty = async () => true;
    const t1 = NOW;
    const t2 = t1 + 9 * HOUR;          // past the 8h cooldown after one failure
    const t3 = t2 + 17 * HOUR;         // past the 16h cooldown after two

    await mod.runOneCycle(TEST_UID, { now: () => t1, reflect, isDirty });
    await mod.runOneCycle(TEST_UID, { now: () => t2, reflect, isDirty });
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt).toEqual({});
    await mod.runOneCycle(TEST_UID, { now: () => t3, reflect, isDirty });

    expect(reflect).toHaveBeenCalledTimes(mod.MAX_FAILURE_STREAK);
    const state = mod.readReflectionState(TEST_UID);
    // The same transcript failed the same way three cycles running: advance
    // past it rather than hold a cap slot for it forever.
    expect(state.lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBe(new Date(t3).toISOString());
    expect(state.failureStreak).toBeUndefined();
  });

  it('a cycle-level cancel does not count as the agent failing', async () => {
    const mod = await loadModule();
    const controller = new AbortController();
    const reflect = vi.fn(async () => {
      controller.abort();
      throw new Error('cancelled by account switch');
    });
    await mod.runOneCycle(TEST_UID, {
      now: () => NOW, reflect, isDirty: async () => true, signal: controller.signal,
    });
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastAttemptAt).toBeUndefined();
    expect(state.failureStreak).toBeUndefined();
  });

  it('skips the cycle without touching any window when every model is cooling down', async () => {
    const mod = await loadModule();
    const reflect = vi.fn();
    const isDirty = vi.fn(async () => true);
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW, reflect, isDirty, isModelUsable: () => false,
    });
    expect(completed).toBe(0);
    expect(reflect).not.toHaveBeenCalled();
    expect(isDirty).not.toHaveBeenCalled();
    expect(mod.readReflectionState(TEST_UID)).toEqual({ lastReflectedAt: {} });
  });

  it('passes model-safe capacity into transcript selection', async () => {
    const observeBudget = vi.fn();
    const mod = await loadModuleWithRunner({ writes: 0, inputBudget: 43210, observeBudget });
    await mod.runOneCycle(TEST_UID, { now: () => NOW, isDirty: async () => true });
    expect(observeBudget).toHaveBeenCalledWith(43210);
  });

  it('does not classify fully cropped evidence as a quiet window', async () => {
    const mod = await loadModuleWithRunner({ writes: 0, transcriptText: '', capacityExceeded: true });
    expect(await mod.runOneCycle(TEST_UID, { now: () => NOW, isDirty: async () => true })).toBe(0);
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBeUndefined();
  });

  it('retains the window when runReflection reports a known failure', async () => {
    const cases: Array<{ kind: string; error?: unknown }> = [
      { kind: 'max_loops' },
      { kind: 'no_provider' },
      { kind: 'llm_error', error: new Error('rotating-provider: no candidates') },
      { kind: 'llm_error', error: new Error('400 Bad Request') },
      { kind: 'empty_output', stopReason: 'end_turn' },
    ];
    for (const failure of cases) {
      const mod = await loadModuleWithRunner({ writes: 0, responseText: '', failure });
      const completed = await mod.runOneCycle(TEST_UID, { now: () => NOW, isDirty: async () => true });
      expect(completed).toBe(0);
      expect(mod.readReflectionState(TEST_UID).lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBeUndefined();
      fs.rmSync(path.join(tmpDir, TEST_UID, 'local', 'config', 'reflection-state.json'), { force: true });
    }
  });

  it('reports a runner that cannot be built as runner_unavailable', async () => {
    const privateDetail = 'provider-private-detail at /private/customer/model-config.json';
    const mod = await loadModuleWithRunner({ writes: 0, buildRunnerError: new Error(privateDetail) });
    const completed = await mod.runOneCycle(TEST_UID, { now: () => NOW, isDirty: async () => true });
    expect(completed).toBe(0);
    expect(loggerMocks.warn).toHaveBeenCalled();
    const logs = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(logs).not.toContain('provider-private-detail');
    expect(logs).not.toContain('/private/customer/');
  });

  it('keeps reflection failure diagnostics private while retaining retry state', async () => {
    const privateAgentId = 'private-agent-123456';
    const mod = await loadModuleWithAgents([privateAgentId]);
    await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      isDirty: async (_uid, agentId) => agentId === privateAgentId,
      reflect: async () => { throw new Error('private-source-detail /private/customer/transcript.jsonl'); },
    });
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt[privateAgentId]).toBeUndefined();
    expect(state.failureStreak?.[privateAgentId]).toBe(1);
    const logs = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(logs).not.toContain(privateAgentId);
    expect(logs).not.toContain('private-source-detail');
    expect(logs).not.toContain('/private/customer/');
  });

  it('skips with debug log when feature flag is off', async () => {
    process.env.ORKAS_METACOGNITION = '0';
    try {
      const mod = await loadModule();
      const reflect = vi.fn();
      const completed = await mod.runOneCycle(TEST_UID, { now: () => NOW, reflect, isDirty: async () => true });
      expect(completed).toBe(0);
      expect(reflect).not.toHaveBeenCalled();
    } finally {
      delete process.env.ORKAS_METACOGNITION;
    }
  });

  it('skips with debug log when uid is empty', async () => {
    const mod = await loadModule();
    const reflect = vi.fn();
    const completed = await mod.runOneCycle('', { now: () => NOW, reflect, isDirty: async () => true });
    expect(completed).toBe(0);
    expect(reflect).not.toHaveBeenCalled();
  });
});

// ── Loop ownership across account switches ─────────────────────────────

describe('reflection-orchestrator › loop lifecycle', () => {
  it('cancels the old account cycle and re-arms the loop for the new account', async () => {
    vi.useFakeTimers({
      now: Date.parse('2026-05-21T12:00:00Z'),
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    });
    const mod = await loadModule();
    const users = await import('../../../src/main/features/users');
    const reflectedUids: string[] = [];
    let resolveReflection!: (uid: string) => void;
    const reflectionStarted = new Promise<string>((resolve) => {
      resolveReflection = resolve;
    });
    const handle = mod.startReflectionLoop(TEST_UID, {
      reflect: async (uid) => {
        reflectedUids.push(uid);
        resolveReflection(uid);
      },
      isDirty: async () => true,
    });

    users.activateUser('u2');
    await vi.advanceTimersByTimeAsync(3_000);
    // Fake timers only drive scheduler admission. Native filesystem promises
    // remain on the real event loop, so wait on the injected reflection seam
    // instead of assuming an arbitrary number of setImmediate turns is enough
    // on a loaded Windows runner.
    await reflectionStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    handle.stop();

    expect(reflectedUids).toEqual(['u2']);
    expect(mod.readReflectionState(TEST_UID).lastReflectedAt).toEqual({});
    expect(mod.readReflectionState('u2').lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBeTruthy();
  });

  it('does not arm a new-account loop when another safety hook rejects the switch', async () => {
    vi.useFakeTimers({
      now: Date.parse('2026-05-21T12:00:00Z'),
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    });
    const mod = await loadModule();
    const users = await import('../../../src/main/features/users');
    const hooks = await import('../../../src/main/features/user-switch-hooks');
    const reflectedUids: string[] = [];
    let resolveReflection!: (uid: string) => void;
    const reflectionStarted = new Promise<string>((resolve) => {
      resolveReflection = resolve;
    });
    const handle = mod.startReflectionLoop(TEST_UID, {
      reflect: async (uid) => {
        reflectedUids.push(uid);
        resolveReflection(uid);
      },
      isDirty: async () => true,
    });
    hooks.registerUserSwitchHook('reflection-test-failure', () => {
      throw new Error('cleanup failed');
    });

    try {
      expect(() => users.activateUser('u2')).toThrow(/user switch cleanup failed/);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(users.getActiveUserId()).toBe(TEST_UID);
      expect(reflectedUids).toEqual([]);

      hooks.registerUserSwitchHook('reflection-test-failure', () => {});
      users.activateUser('u2');
      await vi.advanceTimersByTimeAsync(3_000);
      await reflectionStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reflectedUids).toEqual(['u2']);
    } finally {
      hooks.registerUserSwitchHook('reflection-test-failure', () => {});
      handle.stop();
    }
  });
});

// ── isAgentDirty (cross-agent dispatch fix) ─────────────────────────────

describe('reflection-orchestrator › isAgentDirty', () => {
  function writeConvIndex(uid: string, conv: { cid: string; agent_id: string }): void {
    const idxPath = path.join(tmpDir, uid, 'cloud', 'chats', '_index.json');
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    const list = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : [];
    list.unshift({
      conversation_id: conv.cid,
      title: `t-${conv.cid}`,
      kind: conv.agent_id ? 'agent_run' : 'normal',
      agent_id: conv.agent_id,
      skill_id: '',
      session_id: `gconv-${conv.cid}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    fs.writeFileSync(idxPath, JSON.stringify(list));
  }

  function writeSessionFile(uid: string, sessionId: string, lines: any[]): void {
    const file = path.join(tmpDir, uid, 'cloud', 'sessions', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('detects dispatched-in agent by gmember mtime even when conv.agent_id differs', async () => {
    // c1 started by "other", commander dispatched "target" via plan_set.
    // No signals.jsonl entries. Old design's listConversations+filter would
    // miss this; the new filesystem-scan path catches it.
    writeConvIndex(TEST_UID, { cid: 'c1', agent_id: 'other' });
    writeSessionFile(TEST_UID, 'gmember-c1-target', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi from target' }], ts: 100 },
    ]);

    const mod = await loadModule();
    expect(await mod.isAgentDirty(TEST_UID, 'target', 0)).toBe(true);
  });

  it('returns false when gmember file mtime is older than sinceMs', async () => {
    writeConvIndex(TEST_UID, { cid: 'c1', agent_id: 'other' });
    const file = path.join(tmpDir, TEST_UID, 'cloud', 'sessions', 'gmember-c1-target.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"role":"assistant","content":[{"type":"text","text":"old"}],"ts":1}\n');
    const ancient = Date.now() - 30 * 86400 * 1000;
    fs.utimesSync(file, ancient / 1000, ancient / 1000);

    const mod = await loadModule();
    const since = Date.now() - 86400 * 1000;  // 1 day ago
    expect(await mod.isAgentDirty(TEST_UID, 'target', since)).toBe(false);
  });

  it('returns false when no gmember file exists for the agent', async () => {
    writeConvIndex(TEST_UID, { cid: 'c1', agent_id: 'other' });
    writeSessionFile(TEST_UID, 'gmember-c1-other', [
      { role: 'assistant', content: [{ type: 'text', text: 'other' }], ts: 100 },
    ]);

    const mod = await loadModule();
    // 'target' has no gmember file → not dirty (regardless of c1's existence)
    expect(await mod.isAgentDirty(TEST_UID, 'target', 0)).toBe(false);
  });
});

// ── readReflectionState / writeReflectionState round-trip ───────────────

describe('reflection-orchestrator › state persistence', () => {
  it('round-trips lastReflectedAt through disk', async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.join(tmpDir, TEST_UID, 'local', 'config'), { recursive: true });
    mod.writeReflectionState(TEST_UID, { lastReflectedAt: { 'agent-x': '2026-05-21T10:00:00Z' } });
    const read = mod.readReflectionState(TEST_UID);
    expect(read.lastReflectedAt['agent-x']).toBe('2026-05-21T10:00:00Z');
  });

  it('returns empty state when file is missing', async () => {
    const mod = await loadModule();
    expect(mod.readReflectionState(TEST_UID)).toEqual({ lastReflectedAt: {} });
  });

  it('returns empty state when file is malformed (defensive)', async () => {
    const mod = await loadModule();
    const dir = path.join(tmpDir, TEST_UID, 'local', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reflection-state.json'), '{not json');
    expect(mod.readReflectionState(TEST_UID)).toEqual({ lastReflectedAt: {} });
  });

  it('does not disclose account ids or parser details for malformed state', async () => {
    const privateUid = 'private-reflection-user-12345';
    const mod = await loadModule();
    const dir = path.join(tmpDir, privateUid, 'local', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reflection-state.json'), '{private parser input');

    expect(mod.readReflectionState(privateUid)).toEqual({ lastReflectedAt: {} });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'reflection-state.json parse failed; treating as empty',
      expect.objectContaining({ user_id: 'priv...2345' }),
    );
    const serialized = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(serialized).not.toContain(privateUid);
    expect(serialized).not.toContain('private parser input');
    expect(serialized).not.toContain(tmpDir);
  });

  it('round-trips attempt stamps and failure streaks, dropping non-positive streaks', async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.join(tmpDir, TEST_UID, 'local', 'config'), { recursive: true });
    mod.writeReflectionState(TEST_UID, {
      lastReflectedAt: { 'agent-x': '2026-05-21T10:00:00Z' },
      lastAttemptAt: { 'agent-x': '2026-05-21T22:00:00Z', 'agent-y': '2026-05-22T01:00:00Z' },
      failureStreak: { 'agent-y': 2, 'agent-z': 0, 'agent-w': -1 },
    });
    expect(mod.readReflectionState(TEST_UID)).toEqual({
      lastReflectedAt: { 'agent-x': '2026-05-21T10:00:00Z' },
      lastAttemptAt: { 'agent-x': '2026-05-21T22:00:00Z', 'agent-y': '2026-05-22T01:00:00Z' },
      failureStreak: { 'agent-y': 2 },
    });
  });

  it('filters out non-string values defensively', async () => {
    const mod = await loadModule();
    writeReflectionState(TEST_UID, { 'a': 'iso', /* @ts-expect-error */ 'b': 123 as any });
    const read = mod.readReflectionState(TEST_UID);
    expect(read.lastReflectedAt).toEqual({ a: 'iso' });
  });
});


describe('reflection bounded busy retry', () => {
  it('checks once after ten minutes, then skips to fourteen hours if still busy', async () => {
    const mod = await loadModuleWithAgents([]);
    vi.useFakeTimers({ now: Date.parse('2026-09-18T09:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let busy = true;
    const reflect = vi.fn(async () => 'reflected' as const);
    const deferred = vi.fn();
    const loop = mod.startReflectionLoop(TEST_UID, { reflect, isDirty: async () => true,
      isIdle: () => !busy, isModelUsable: () => true, onDeferred: deferred });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(deferred).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
      expect(deferred).toHaveBeenCalledTimes(2);
      expect(reflect).not.toHaveBeenCalled();
      busy = false;
      await vi.advanceTimersByTimeAsync(14 * 3600 * 1000 - 1);
      expect(reflect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reflect).toHaveBeenCalledTimes(1);
    } finally { loop.stop(); }
  });

  it('retries an interrupted inference after ten minutes without recording a failure', async () => {
    const mod = await loadModuleWithAgents([]);
    const { yieldReflectionForTask } = await import('../../../src/main/features/reflection-coordination');
    vi.useFakeTimers({ now: Date.parse('2026-09-18T09:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let calls = 0;
    const reflect = vi.fn(async () => {
      if (++calls === 1) return await new Promise<never>(() => {}); // Deliberately ignores abort.
      return 'reflected' as const;
    });
    const loop = mod.startReflectionLoop(TEST_UID, { reflect, isDirty: async () => true,
      isIdle: () => true, isModelUsable: () => true });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(reflect).toHaveBeenCalledTimes(1);
      expect(yieldReflectionForTask(TEST_UID)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(mod.readReflectionState(TEST_UID)).toEqual({ lastReflectedAt: {} });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
      expect(reflect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reflect).toHaveBeenCalledTimes(2);
      expect(mod.readReflectionState(TEST_UID).lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBeTruthy();
    } finally { loop.stop(); }
  });

  it('an interruption during the one retry cannot schedule a third attempt', async () => {
    const mod = await loadModuleWithAgents([]);
    const { yieldReflectionForTask } = await import('../../../src/main/features/reflection-coordination');
    vi.useFakeTimers({ now: Date.parse('2026-09-18T09:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let idle = false;
    const reflect = vi.fn(async () => new Promise<never>(() => {}));
    const loop = mod.startReflectionLoop(TEST_UID, { reflect, isDirty: async () => true,
      isIdle: () => idle, isModelUsable: () => true });
    try {
      await vi.advanceTimersByTimeAsync(1);
      idle = true;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(reflect).toHaveBeenCalledTimes(1);
      yieldReflectionForTask(TEST_UID);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(14 * 3600 * 1000 - 1);
      expect(reflect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reflect).toHaveBeenCalledTimes(2);
    } finally { loop.stop(); await vi.advanceTimersByTimeAsync(0); }
  });

  it('stopping a pending busy retry leaves no later execution', async () => {
    const mod = await loadModuleWithAgents([]);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let idle = false;
    const reflect = vi.fn();
    const loop = mod.startReflectionLoop(TEST_UID, { reflect, isDirty: async () => true, isIdle: () => idle });
    await vi.advanceTimersByTimeAsync(1);
    loop.stop();
    idle = true;
    await vi.advanceTimersByTimeAsync(15 * 3600 * 1000);
    expect(reflect).not.toHaveBeenCalled();
  });
});
