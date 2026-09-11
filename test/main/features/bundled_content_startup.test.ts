import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'bundled-content-user';
const TEST_AGENT_ID = '222222222222';
const TEST_SKILL_ID = 'platform-writing';

let tmpDir: string;
let prevWs: string | undefined;
let prevBuiltin: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bundled-content-startup-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevBuiltin = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.ORKAS_BUILTIN_ROOT = path.join(tmpDir, 'builtin');
  vi.resetModules();
  writePackagedContent();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevBuiltin === undefined) delete process.env.ORKAS_BUILTIN_ROOT;
  else process.env.ORKAS_BUILTIN_ROOT = prevBuiltin;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writePackagedContent(): void {
  const builtin = path.join(tmpDir, 'builtin');
  const systemRoot = path.join(builtin, 'system', 'skills');
  writeJson(path.join(systemRoot, '_system.json'), {
    skills: [{ id: 'orkas-guide', update_at: 2026081401 }],
  });
  fs.mkdirSync(path.join(systemRoot, 'orkas-guide'), { recursive: true });
  fs.writeFileSync(
    path.join(systemRoot, 'orkas-guide', 'SKILL.md'),
    '---\nname: orkas-guide\ndescription: Manage project tasks\n---\n\n# Project tasks\n',
    'utf8',
  );

  writeJson(path.join(builtin, 'marketplace', 'agents', TEST_AGENT_ID, 'agent.json'), {
    agent_id: TEST_AGENT_ID,
    version: '1.0.0',
    name: 'PlatformAgent',
    description: 'A bundled platform Agent',
    category: 'creation',
  });
  const skillRoot = path.join(builtin, 'marketplace', 'skills', TEST_SKILL_ID);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${TEST_SKILL_ID}\ndescription: A bundled platform Skill\nversion: 1.0.0\n---\n\n# Platform writing\n`,
    'utf8',
  );
}

async function activateTestUser() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  return import('../../../src/main/paths');
}

describe('bundled content startup boundary', () => {
  it('publishes System Skills and platform Agents/Skills before a warm no-op pass', async () => {
    const paths = await activateTestUser();
    const startup = await import('../../../src/main/features/bundled_content_startup');

    await expect(startup.syncBundledContentForUser(UID, { reason: 'first-window' }))
      .resolves.toMatchObject({
        system_skills: [{ id: 'orkas-guide', action: 'created' }],
        marketplace: {
          seeded_agents: 1,
          seeded_skills: 1,
          manifest_agents: 1,
          manifest_skills: 1,
        },
        failed: [],
      });
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'orkas-guide'), 'SKILL.md')))
      .toBe(true);
    expect(fs.existsSync(path.join(paths.userMarketplaceAgentDir(UID, TEST_AGENT_ID), 'agent.json')))
      .toBe(true);
    expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir(UID, TEST_SKILL_ID), 'SKILL.md')))
      .toBe(true);

    await expect(startup.syncBundledContentForUser(UID, { reason: 'warm-start' }))
      .resolves.toMatchObject({
        system_skills: [{ id: 'orkas-guide', action: 'skipped' }],
        marketplace: {
          seeded_agents: 0,
          seeded_skills: 0,
          manifest_agents: 0,
          manifest_skills: 0,
        },
        failed: [],
      });
  });

  it('continues publishing platform content when the System Skill mirror is unwritable', async () => {
    const paths = await activateTestUser();
    fs.rmSync(paths.userSystemSkillsDir(UID), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(paths.userSystemSkillsDir(UID)), { recursive: true });
    fs.writeFileSync(paths.userSystemSkillsDir(UID), 'blocks directory creation', 'utf8');
    const startup = await import('../../../src/main/features/bundled_content_startup');

    const result = await startup.syncBundledContentForUser(UID, { reason: 'failure-injection' });

    expect(result.failed).toContain('system_skills');
    expect(result.marketplace).toMatchObject({ seeded_agents: 1, seeded_skills: 1 });
    expect(fs.existsSync(path.join(paths.userMarketplaceAgentDir(UID, TEST_AGENT_ID), 'agent.json')))
      .toBe(true);
  });

  it('keeps System Skills available when bundled Marketplace publication fails', async () => {
    const paths = await activateTestUser();
    fs.rmSync(paths.userMarketplaceDir(UID), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(paths.userMarketplaceDir(UID)), { recursive: true });
    fs.writeFileSync(paths.userMarketplaceDir(UID), 'blocks directory creation', 'utf8');
    const startup = await import('../../../src/main/features/bundled_content_startup');

    const result = await startup.syncBundledContentForUser(UID, { reason: 'failure-injection' });

    expect(result.failed).toContain('marketplace');
    expect(result.system_skills).toEqual([
      expect.objectContaining({ id: 'orkas-guide', action: 'created' }),
    ]);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'orkas-guide'), 'SKILL.md')))
      .toBe(true);
  });

  it('coalesces simultaneous startup and account-change triggers for one user', async () => {
    await activateTestUser();
    const systemSkills = await import('../../../src/main/features/system_skills');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = vi.spyOn(systemSkills, 'reconcileAllForUserWithRetry')
      .mockImplementation(async () => {
        await gate;
        return [];
      });
    const startup = await import('../../../src/main/features/bundled_content_startup');

    const first = startup.syncBundledContentForUser(UID, { reason: 'startup' });
    const second = startup.syncBundledContentForUser(UID, { reason: 'account-change' });
    expect(reconcile).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('makes repeated boot and login triggers free after one complete pass, without touching a different user', async () => {
    // A logged-in boot fires first-window, account bootstrap, and the delayed
    // login-capabilities pass for the same uid; only the first may walk the
    // packaged directories. A non-startup reason still performs a real pass.
    const paths = await activateTestUser();
    const systemSkills = await import('../../../src/main/features/system_skills');
    const marketplaceStartup = await import('../../../src/main/features/builtin_marketplace_startup');
    const reconcile = vi.spyOn(systemSkills, 'reconcileAllForUserWithRetry');
    const seed = vi.spyOn(marketplaceStartup, 'seedBuiltinMarketplaceForUser');
    const startup = await import('../../../src/main/features/bundled_content_startup');

    const first = await startup.syncBundledContentForUser(UID, { reason: 'first-window' });
    expect(first.failed).toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledTimes(1);

    for (const reason of ['startup', 'account-change', 'startup']) {
      await expect(startup.syncBundledContentForUser(UID, { reason }))
        .resolves.toEqual({ system_skills: [], marketplace: null, failed: [] });
    }
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'orkas-guide'), 'SKILL.md')))
      .toBe(true);
    expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir(UID, TEST_SKILL_ID), 'SKILL.md')))
      .toBe(true);

    const other = 'bundled-content-other-user';
    const users = await import('../../../src/main/features/users');
    users.activateUser(other);
    await expect(startup.syncBundledContentForUser(other, { reason: 'account-change' }))
      .resolves.toMatchObject({ system_skills: [{ id: 'orkas-guide', action: 'created' }], failed: [] });
    expect(reconcile).toHaveBeenCalledTimes(2);

    await expect(startup.syncBundledContentForUser(UID, { reason: 'manual-refresh' }))
      .resolves.toMatchObject({ system_skills: [{ id: 'orkas-guide', action: 'skipped' }], failed: [] });
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('retries a failed or interrupted pass on the next startup trigger (negative control)', async () => {
    const paths = await activateTestUser();
    const systemSkills = await import('../../../src/main/features/system_skills');
    const reconcile = vi.spyOn(systemSkills, 'reconcileAllForUserWithRetry');
    const startup = await import('../../../src/main/features/bundled_content_startup');

    const interrupted = await startup.syncBundledContentForUser(UID, {
      reason: 'first-window',
      shouldContinue: () => false,
    });
    expect(interrupted).toEqual({ system_skills: [], marketplace: null, failed: [] });
    expect(reconcile).not.toHaveBeenCalled();

    fs.rmSync(paths.userSystemSkillsDir(UID), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(paths.userSystemSkillsDir(UID)), { recursive: true });
    fs.writeFileSync(paths.userSystemSkillsDir(UID), 'blocks directory creation', 'utf8');
    const failed = await startup.syncBundledContentForUser(UID, { reason: 'startup' });
    expect(failed.failed).toContain('system_skills');
    expect(reconcile).toHaveBeenCalledTimes(1);

    fs.rmSync(paths.userSystemSkillsDir(UID), { force: true });
    const repaired = await startup.syncBundledContentForUser(UID, { reason: 'startup' });
    expect(repaired.failed).toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'orkas-guide'), 'SKILL.md')))
      .toBe(true);

    await startup.syncBundledContentForUser(UID, { reason: 'startup' });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('publishes again after an account switch resets the target workspace', async () => {
    // Logout recreates the anonymous root, so the account-change trigger that
    // follows a switch must not be treated as a repeat of the boot pass.
    const paths = await activateTestUser();
    const systemSkills = await import('../../../src/main/features/system_skills');
    const reconcile = vi.spyOn(systemSkills, 'reconcileAllForUserWithRetry');
    const hooks = await import('../../../src/main/features/user-switch-hooks');
    const startup = await import('../../../src/main/features/bundled_content_startup');

    await startup.syncBundledContentForUser(UID, { reason: 'first-window' });
    await startup.syncBundledContentForUser(UID, { reason: 'account-change' });
    expect(reconcile).toHaveBeenCalledTimes(1);

    fs.rmSync(paths.userSystemSkillsDir(UID), { recursive: true, force: true });
    hooks.notifyUserSwitch('previous-account', UID);
    await expect(startup.syncBundledContentForUser(UID, { reason: 'account-change' }))
      .resolves.toMatchObject({ system_skills: [{ id: 'orkas-guide', action: 'created' }], failed: [] });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'orkas-guide'), 'SKILL.md')))
      .toBe(true);
  });
});
