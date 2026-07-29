import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Signal } from '../../../src/main/features/expert_signals/types';

const mocks = vi.hoisted(() => ({
  querySignalsForUser: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/main/features/expert_signals', () => ({
  querySignalsForUser: mocks.querySignalsForUser,
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));

const FIXED_NOW = new Date('2026-07-25T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skill-metrics-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  mocks.querySignalsForUser.mockReset();
  mocks.querySignalsForUser.mockResolvedValue([]);
  mocks.warn.mockReset();
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function signal(overrides: Partial<Signal> & Pick<Signal, 'type'>): Signal {
  return {
    id: `sig-${Math.random()}`,
    ts: FIXED_NOW.toISOString(),
    source: 'event',
    cid: 'conversation-a',
    aid: 'agent-a',
    turn_id: 'turn-a',
    context_ref: { msg_ids: [] },
    extractor_version: 'event@1.0',
    ...overrides,
  } as Signal;
}

function advertised(skillId: string, turnId: string, cid = 'conversation-a'): Signal {
  return signal({
    type: 'skill_advertised',
    cid,
    turn_id: turnId,
    delta: { system: 'A.custom', skill_ids: [skillId] },
  });
}

function invoked(skillId: string, turnId: string, cid = 'conversation-a'): Signal {
  return signal({
    type: 'skill_invoked',
    cid,
    turn_id: turnId,
    delta: { system: 'A.custom', skill_id: skillId, trigger: 'read_file' },
  });
}

function reaction(type: 'correction' | 'edit', turnId: string, cid = 'conversation-a'): Signal {
  return signal({ type, cid, turn_id: turnId });
}

function ineffective(skillId: string, turnId: string, cid = 'conversation-a'): Signal {
  return signal({
    type: 'skill_ineffective',
    cid,
    turn_id: turnId,
    delta: { system: 'A.custom', skill_id: skillId },
  });
}

async function aggregate(userId = 'account-a', sinceDays = 7) {
  const mod = await import('../../../src/main/features/skill_metrics');
  return mod.aggregateSkillMetrics(userId, { sinceDays });
}

function row(report: Awaited<ReturnType<typeof aggregate>>, skillId: string, system = 'A.custom') {
  return report.rows.find((item) => (
    item.skill_id === skillId && item.skill_system === system
  ));
}

function writeSkill(
  userId: string,
  source: 'custom' | 'marketplace',
  skillId: string,
  name: string,
): void {
  const root = source === 'custom'
    ? path.join(tmpDir, userId, 'cloud', 'skills')
    : path.join(tmpDir, userId, 'local', 'marketplace', 'skills');
  const dir = path.join(root, skillId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
}

describe('aggregateSkillMetrics', () => {
  it('returns an explicit successful empty report for an account with no signals', async () => {
    const report = await aggregate('empty-account', 1);

    expect(report).toMatchObject({
      rows: [],
      total_signals_scanned: 0,
      data_status: 'ok',
      truncated: false,
      summary: { total: 0 },
    });
    expect(mocks.querySignalsForUser).toHaveBeenCalledWith(
      'empty-account',
      expect.objectContaining({ limit: 10_000 }),
    );
  });

  it('counts each skill once per conversation turn despite duplicate signal lines', async () => {
    mocks.querySignalsForUser.mockResolvedValue([
      advertised('summary-writer', 'turn-1'),
      advertised('summary-writer', 'turn-1'),
      advertised('summary-writer', 'turn-2'),
      invoked('summary-writer', 'turn-1'),
      invoked('summary-writer', 'turn-1'),
      reaction('correction', 'turn-1'),
      reaction('edit', 'turn-1'),
      ineffective('summary-writer', 'turn-1'),
      ineffective('summary-writer', 'turn-1'),
    ]);

    const report = await aggregate();

    expect(row(report, 'summary-writer')).toMatchObject({
      advertised: 2,
      invoked: 1,
      invocation_rate: 0.5,
      modified_after_hit: 1,
      modified_after_hit_rate: 1,
      ineffective: 1,
      ineffective_rate: 1,
    });
  });

  it('does not join a reaction from another conversation that reused the same turn id', async () => {
    mocks.querySignalsForUser.mockResolvedValue([
      invoked('review-skill', 'shared-turn', 'conversation-a'),
      reaction('correction', 'shared-turn', 'conversation-b'),
    ]);

    const report = await aggregate();

    expect(row(report, 'review-skill')).toMatchObject({
      invoked: 1,
      modified_after_hit: 0,
      modified_after_hit_rate: 0,
    });
  });

  it('keeps identical skill ids in different systems as separate rows', async () => {
    mocks.querySignalsForUser.mockResolvedValue([
      invoked('shared-id', 'turn-custom'),
      signal({
        type: 'skill_invoked',
        turn_id: 'turn-platform',
        delta: { system: 'A.platform', skill_id: 'shared-id', trigger: 'read_file' },
      }),
    ]);

    const report = await aggregate();

    expect(row(report, 'shared-id', 'A.custom')).toBeDefined();
    expect(row(report, 'shared-id', 'A.platform')).toBeDefined();
  });

  it('ignores malformed skill payloads and ineffective signals without a matching invocation', async () => {
    mocks.querySignalsForUser.mockResolvedValue([
      signal({
        type: 'skill_advertised',
        delta: { system: 'A.custom', skill_ids: '../not-an-array' as any },
      }),
      signal({
        type: 'skill_invoked',
        delta: { system: 'unknown' as any, skill_id: 'bad-system', trigger: 'read_file' },
      }),
      ineffective('orphan-failure', 'turn-orphan'),
    ]);

    const report = await aggregate();

    expect(report.rows).toEqual([]);
  });

  it('uses only the requested account for both signals and display-name lookup', async () => {
    writeSkill('account-a', 'marketplace', 'shared-skill', 'Marketplace A');
    writeSkill('account-a', 'custom', 'shared-skill', 'Custom A');
    writeSkill('account-b', 'custom', 'shared-skill', 'Private B');
    mocks.querySignalsForUser.mockResolvedValue([
      invoked('shared-skill', 'turn-1'),
    ]);

    const report = await aggregate('account-a');

    expect(mocks.querySignalsForUser).toHaveBeenCalledWith(
      'account-a',
      expect.any(Object),
    );
    expect(row(report, 'shared-skill')?.display_name).toBe('Custom A');
    expect(JSON.stringify(report)).not.toContain('Private B');
  });

  it('distinguishes a query failure from a valid no-data result and redacts its log', async () => {
    mocks.querySignalsForUser.mockRejectedValue(
      new Error('cannot read /Users/test/private/signals.jsonl'),
    );

    const report = await aggregate();

    expect(report).toMatchObject({
      rows: [],
      total_signals_scanned: 0,
      data_status: 'error',
      truncated: false,
    });
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).not.toContain('/Users/test/private/signals.jsonl');
    expect(logged).toContain('message_hash');
  });

  it('normalizes invalid or excessive ranges to the supported 1–30 day window', async () => {
    await aggregate('account-a', Number.NaN);
    await aggregate('account-a', -4);
    await aggregate('account-a', 365);
    await aggregate('account-a', 1.9);

    const windows = mocks.querySignalsForUser.mock.calls.map(([, filter]) => (
      (Date.parse(filter.until) - Date.parse(filter.since)) / DAY_MS
    ));
    expect(windows).toEqual([7, 1, 30, 1]);
  });

  it('warns consumers when the storage hard cap makes the report potentially incomplete', async () => {
    mocks.querySignalsForUser.mockResolvedValue(
      Array.from({ length: 10_000 }, (_, index) => signal({
        type: 'accept',
        id: `sig-${index}`,
        turn_id: `turn-${index}`,
      })),
    );

    const report = await aggregate();

    expect(report.total_signals_scanned).toBe(10_000);
    expect(report.truncated).toBe(true);
  });

  it('classifies health from exact per-turn outcomes and surfaces unhealthy rows first', async () => {
    const signals: Signal[] = [];
    for (let index = 0; index < 5; index += 1) {
      signals.push(advertised('underused-skill', `underused-${index}`));
    }
    for (let index = 0; index < 2; index += 1) {
      signals.push(invoked('review-skill', `review-${index}`));
      signals.push(reaction('correction', `review-${index}`));
    }
    signals.push(invoked('ineffective-skill', 'bad-1'));
    signals.push(ineffective('ineffective-skill', 'bad-1'));
    for (let index = 0; index < 3; index += 1) {
      signals.push(advertised('healthy-skill', `healthy-ad-${index}`));
    }
    signals.push(invoked('healthy-skill', 'healthy-ad-0'));
    signals.push(invoked('low-data-skill', 'low-data-1'));
    mocks.querySignalsForUser.mockResolvedValue(signals);

    const report = await aggregate();

    expect(row(report, 'underused-skill')?.health_status).toBe('underused');
    expect(row(report, 'review-skill')?.health_status).toBe('needs_review');
    expect(row(report, 'ineffective-skill')?.health_status).toBe('ineffective');
    expect(row(report, 'healthy-skill')?.health_status).toBe('healthy');
    expect(row(report, 'low-data-skill')?.health_status).toBe('insufficient_data');
    expect(report.rows.map((item) => item.health_status)).toEqual([
      'ineffective',
      'needs_review',
      'underused',
      'insufficient_data',
      'healthy',
    ]);
    expect(report.summary).toEqual({
      healthy: 1,
      underused: 1,
      needs_review: 1,
      ineffective: 1,
      insufficient_data: 1,
      total: 5,
    });
  });
});
