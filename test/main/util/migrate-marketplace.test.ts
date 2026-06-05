import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-marketplace';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-migrate-marketplace-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMigration() {
  const paths = await import('../../../src/main/paths');
  const migration = await import('../../../src/main/util/migrate-marketplace');
  return { paths, migration };
}

describe('util/migrate-marketplace', () => {
  it('moves legacy builtin agents and skills into the active user cloud tree', async () => {
    const { paths, migration } = await loadMigration();
    const legacyAgent = path.join(tmpDir, 'builtin', 'agents', 'agent-a');
    const legacySkill = path.join(tmpDir, 'builtin', 'skills', 'skill-a');
    fs.mkdirSync(legacyAgent, { recursive: true });
    fs.mkdirSync(legacySkill, { recursive: true });
    fs.writeFileSync(path.join(legacyAgent, 'agent.json'), '{"id":"agent-a"}', 'utf8');
    fs.writeFileSync(path.join(legacyAgent, '_marketplace.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), '# Skill A', 'utf8');

    const result = await migration.migrateLegacyBuiltinToCloud(TEST_UID);

    expect(result).toEqual({ moved_agents: 1, moved_skills: 1 });
    expect(fs.existsSync(path.join(paths.userAgentsDir(TEST_UID), 'agent-a', 'agent.json'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userAgentsDir(TEST_UID), 'agent-a', '_marketplace.json'))).toBe(false);
    expect(fs.existsSync(path.join(paths.userSkillsDir(TEST_UID), 'skill-a', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'builtin'))).toBe(false);
  });

  it('merges legacy children into an existing cloud item instead of dropping them', async () => {
    const { paths, migration } = await loadMigration();
    const legacyAgent = path.join(tmpDir, 'builtin', 'agents', 'agent-a');
    const cloudAgent = path.join(paths.userAgentsDir(TEST_UID), 'agent-a');
    fs.mkdirSync(legacyAgent, { recursive: true });
    fs.mkdirSync(path.join(cloudAgent, 'meta'), { recursive: true });
    fs.writeFileSync(path.join(legacyAgent, 'agent.json'), '{"id":"agent-a"}', 'utf8');
    fs.writeFileSync(path.join(cloudAgent, 'meta', 'existing.txt'), 'keep', 'utf8');

    const result = await migration.migrateLegacyBuiltinToCloud(TEST_UID);

    expect(result.moved_agents).toBe(1);
    expect(fs.readFileSync(path.join(cloudAgent, 'agent.json'), 'utf8')).toBe('{"id":"agent-a"}');
    expect(fs.readFileSync(path.join(cloudAgent, 'meta', 'existing.txt'), 'utf8')).toBe('keep');
  });
});
