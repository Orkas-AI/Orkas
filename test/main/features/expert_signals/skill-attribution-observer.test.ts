import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  observeSkillAttribution,
  parseObserverArgs,
  SkillAttributionMatcher,
} from '../../../../scripts/observe-skill-attribution.mjs';

let root = '';
let dataRoot = '';
let signalFile = '';

function signal(
  type: 'skill_advertised' | 'skill_invoked',
  turnId: string,
  skillId = 'target-skill',
): string {
  return JSON.stringify({
    type,
    turn_id: turnId,
    aid: 'agent-1',
    delta: type === 'skill_advertised'
      ? { skill_ids: [skillId] }
      : { skill_id: skillId },
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skill-observer-'));
  dataRoot = path.join(root, 'data');
  const uid = 'user-1';
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'users.json'), JSON.stringify({
    current_user_id: uid,
  }));
  const day = '2026-07-25';
  signalFile = path.join(dataRoot, uid, 'local', 'signals', `${day}.jsonl`);
  fs.mkdirSync(path.dirname(signalFile), { recursive: true });
  fs.writeFileSync(signalFile, '');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('skill-attribution observer', () => {
  it('validates the expected skill id and bounded timeout', () => {
    expect(parseObserverArgs([])).toEqual({
      skillId: 'e2e-test-skill',
      timeoutSeconds: 180,
    });
    expect(parseObserverArgs(['my-skill', '5'])).toEqual({
      skillId: 'my-skill',
      timeoutSeconds: 5,
    });
    expect(() => parseObserverArgs(['../escape', '5'])).toThrow('skill id');
    expect(() => parseObserverArgs(['skill', '0'])).toThrow('between 1 and 3600');
    expect(() => parseObserverArgs(['skill', '1.5'])).toThrow('integer');
  });

  it('matches by turn-set intersection instead of failing on legitimate interleaving', async () => {
    let clock = new Date(2026, 6, 25, 12, 0, 0).getTime();
    let polls = 0;
    const log = vi.fn();
    const result = await observeSkillAttribution({
      dataRoot,
      expectedSkillId: 'target-skill',
      log,
      logError: vi.fn(),
      now: () => clock,
      pollIntervalMs: 10,
      timeoutSeconds: 1,
      wait: async (milliseconds: number) => {
        clock += milliseconds;
        polls += 1;
        if (polls === 1) {
          fs.appendFileSync(
            signalFile,
            `${signal('skill_advertised', 'turn-a')}\n${signal('skill_invoked', 'turn-b')}\n`,
          );
        } else if (polls === 2) {
          fs.appendFileSync(signalFile, `${signal('skill_invoked', 'turn-a')}\n`);
        }
      },
    });

    expect(result).toEqual({ code: 0, matchedTurn: 'turn-a' });
    expect(log).toHaveBeenCalledWith('[skill-attribution] PASS turn_id=turn-a');
    expect(log.mock.calls.flat().join('\n')).not.toContain('mismatch');
  });

  it('ignores historical matches, malformed records, other skills, and partial lines', async () => {
    fs.writeFileSync(
      signalFile,
      `${signal('skill_advertised', 'historical')}\n${signal('skill_invoked', 'historical')}\n`,
    );
    let clock = new Date(2026, 6, 25, 12, 0, 0).getTime();
    let polls = 0;
    const advertised = signal('skill_advertised', 'fresh');
    const split = Math.floor(advertised.length / 2);
    const result = await observeSkillAttribution({
      dataRoot,
      expectedSkillId: 'target-skill',
      log: vi.fn(),
      logError: vi.fn(),
      now: () => clock,
      pollIntervalMs: 10,
      timeoutSeconds: 1,
      wait: async (milliseconds: number) => {
        clock += milliseconds;
        polls += 1;
        if (polls === 1) {
          fs.appendFileSync(
            signalFile,
            `{broken\n${signal('skill_invoked', 'other-turn', 'other-skill')}\n${advertised.slice(0, split)}`,
          );
        } else if (polls === 2) {
          fs.appendFileSync(
            signalFile,
            `${advertised.slice(split)}\n${signal('skill_invoked', 'fresh')}\n`,
          );
        }
      },
    });

    expect(result).toEqual({ code: 0, matchedTurn: 'fresh' });
  });

  it('times out accurately when only one side arrives', async () => {
    let clock = new Date(2026, 6, 25, 12, 0, 0).getTime();
    let appended = false;
    const logError = vi.fn();
    const result = await observeSkillAttribution({
      dataRoot,
      expectedSkillId: 'target-skill',
      log: vi.fn(),
      logError,
      now: () => clock,
      pollIntervalMs: 100,
      timeoutSeconds: 1,
      wait: async (milliseconds: number) => {
        clock += milliseconds;
        if (!appended) {
          appended = true;
          fs.appendFileSync(signalFile, `${signal('skill_advertised', 'turn-a')}\n`);
        }
      },
    });

    expect(result).toEqual({ code: 1, matchedTurn: null });
    expect(logError).toHaveBeenCalledWith(
      '[skill-attribution] TIMEOUT advertised_turns=1 invoked_turns=0',
    );
  });

  it('rejects a corrupt traversal-shaped active uid without creating or reading outside data root', async () => {
    fs.writeFileSync(path.join(dataRoot, 'users.json'), JSON.stringify({
      current_user_id: '../../outside',
    }));
    const logError = vi.fn();

    expect(await observeSkillAttribution({
      dataRoot,
      expectedSkillId: 'target-skill',
      log: vi.fn(),
      logError,
      now: () => Date.now(),
      pollIntervalMs: 1,
      timeoutSeconds: 1,
      wait: async () => {},
    })).toEqual({ code: 2, matchedTurn: null });
    expect(logError).toHaveBeenCalledWith(
      '[skill-attribution] current_user_id is missing or invalid',
    );
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false);
  });

  it('keeps a thin shell entry and removes the redundant non-gating tail script', () => {
    const scripts = path.join(process.cwd(), 'scripts');
    const wrapper = fs.readFileSync(
      path.join(scripts, 'observe-skill-attribution.sh'),
      'utf8',
    );

    expect(wrapper).toContain('exec node "$SCRIPT_DIR/observe-skill-attribution.mjs" "$@"');
    expect(fs.existsSync(path.join(scripts, 'watch-signals.sh'))).toBe(false);
  });
});

describe('SkillAttributionMatcher', () => {
  it('rejects control-character turn ids instead of emitting terminal control data', () => {
    const matcher = new SkillAttributionMatcher('target-skill');
    expect(matcher.ingest(signal('skill_advertised', 'turn\u001b[31m'))).toBeNull();
  });
});
