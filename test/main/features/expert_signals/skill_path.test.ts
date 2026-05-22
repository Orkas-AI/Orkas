import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// paths.ts resolves WS_ROOT from env at module load. We don't write any
// files in these tests (parseSkillPath is pure path-string parsing) — just
// need WS_ROOT set so the path helpers compute deterministic prefixes.

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skill-path-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('expert_signals.skill_path › positives', () => {
  it('A.custom: <uid>/cloud/skills/<id>/SKILL.md', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.userSkillsDir('uid1'), 'summary-writer', 'SKILL.md');
    expect(parseSkillPath(abs, 'uid1')).toEqual({
      system: 'A.custom',
      skill_id: 'summary-writer',
    });
  });

  it('A.platform: <uid>/local/marketplace/skills/<id>/SKILL.md', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.userMarketplaceSkillsDir('uid1'), 'a1b2c3d4e5f6', 'SKILL.md');
    expect(parseSkillPath(abs, 'uid1')).toEqual({
      system: 'A.platform',
      skill_id: 'a1b2c3d4e5f6',
    });
  });

  it('B: <uid>/cloud/agents/<aid>/skills/<sid>/SKILL.md (carries agent_id)', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.agentEvolvedSkillsDir('uid1', 'agent_x'), 'self-evolved-skill', 'SKILL.md');
    expect(parseSkillPath(abs, 'uid1')).toEqual({
      system: 'B',
      skill_id: 'self-evolved-skill',
      agent_id: 'agent_x',
    });
  });
});

describe('expert_signals.skill_path › negatives', () => {
  it('non-SKILL.md filename under a skill root → null', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.userSkillsDir('uid1'), 'foo', 'helper.py');
    expect(parseSkillPath(abs, 'uid1')).toBeNull();
  });

  it('SKILL.md outside any skill root → null', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.userRoot('uid1'), 'cloud', 'memory', 'SKILL.md');
    expect(parseSkillPath(abs, 'uid1')).toBeNull();
  });

  it('A.custom with extra nested dir → null (skill_id must be a leaf dir)', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    // .../skills/foo/bar/SKILL.md — two segments before SKILL.md, not the
    // expected one. Catches accidental nested-skill layouts.
    const abs = path.join(p.userSkillsDir('uid1'), 'foo', 'bar', 'SKILL.md');
    expect(parseSkillPath(abs, 'uid1')).toBeNull();
  });

  it('System B path missing the literal "skills" segment → null', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    // Wrong shape: <agents-root>/<aid>/meta/<sid>/SKILL.md (meta, not skills)
    const abs = path.join(p.userAgentsDir('uid1'), 'agent_x', 'meta', 'sid', 'SKILL.md');
    expect(parseSkillPath(abs, 'uid1')).toBeNull();
  });

  it('different uid → null (path scoping is uid-specific)', async () => {
    const { parseSkillPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.userSkillsDir('uid1'), 'foo', 'SKILL.md');
    expect(parseSkillPath(abs, 'uid2')).toBeNull();
  });

  it('empty inputs → null (defensive)', async () => {
    const { parseSkillPath, isSkillMdPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    expect(parseSkillPath('', 'uid1')).toBeNull();
    expect(parseSkillPath('/some/path/SKILL.md', '')).toBeNull();
    expect(isSkillMdPath('', 'uid1')).toBe(false);
  });
});

describe('expert_signals.skill_path › isSkillMdPath delegates to parseSkillPath', () => {
  it('returns true for an A.custom path', async () => {
    const { isSkillMdPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.userSkillsDir('uid1'), 'foo', 'SKILL.md');
    expect(isSkillMdPath(abs, 'uid1')).toBe(true);
  });

  it('returns false for a non-SKILL.md path', async () => {
    const { isSkillMdPath } = await import('../../../../src/main/features/expert_signals/skill_path');
    const p = await import('../../../../src/main/paths');
    const abs = path.join(p.userSkillsDir('uid1'), 'foo', 'README.md');
    expect(isSkillMdPath(abs, 'uid1')).toBe(false);
  });
});
