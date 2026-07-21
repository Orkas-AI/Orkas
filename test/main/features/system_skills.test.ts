import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'system-skills-user';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  vi.doUnmock('node:fs');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-system-skills-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function packagedSystemSkill(id: string): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), 'resources', 'builtin', 'system', 'skills', id, 'SKILL.md'),
    'utf8',
  );
}

function frontmatterOf(md: string): string {
  expect(md.startsWith('---\n')).toBe(true);
  const end = md.indexOf('\n---', 4);
  expect(end).toBeGreaterThan(0);
  return md.slice(4, end);
}

describe('system skills reconciliation', () => {
  it('copies packaged creator skills into the active user local system root', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    const results = await systemSkills.reconcileAllForActiveUser();
    expect(results.map((r) => [r.id, r.action]).sort()).toEqual([
      ['agent-creator', 'created'],
      ['autotask-creator', 'created'],
      ['coding', 'created'],
      ['package-installer', 'created'],
      ['skill-creator', 'created'],
    ]);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'agent-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'autotask-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'package-installer'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'skill-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(paths.userSystemSkillsManifestFile(UID))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'agent-creator'), '_system.json'))).toBe(false);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'skill-creator'), '_system.json'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(paths.userSystemSkillsManifestFile(UID), 'utf8'));
    expect(manifest.map((entry: any) => Object.keys(entry).sort()))
      .toEqual(manifest.map(() => ['id', 'update_at']));
  });

  it('copies packaged creator skills into a specified user local system root', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    const loginUid = 'login-system-user';
    const results = await systemSkills.reconcileAllForUser(loginUid);
    expect(results.map((r) => [r.id, r.action]).sort()).toEqual([
      ['agent-creator', 'created'],
      ['autotask-creator', 'created'],
      ['coding', 'created'],
      ['package-installer', 'created'],
      ['skill-creator', 'created'],
    ]);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(loginUid, 'agent-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(loginUid, 'autotask-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(loginUid, 'package-installer'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(loginUid, 'skill-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(paths.userSystemSkillDir(UID, 'agent-creator'))).toBe(false);
  });

  it('skips identical update_at values and updates only stale manifest entries', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    await systemSkills.reconcileAllForActiveUser();
    fs.writeFileSync(path.join(paths.userSystemSkillDir(UID, 'agent-creator'), '_system.json'), '{}');
    const skipped = await systemSkills.reconcileAllForActiveUser();
    expect(skipped.map((r) => r.action)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'agent-creator'), '_system.json'))).toBe(false);

    const skillManifest = paths.userSystemSkillsManifestFile(UID);
    const stale = JSON.parse(fs.readFileSync(skillManifest, 'utf8'));
    const skillEntry = stale.find((entry: any) => entry.id === 'skill-creator');
    skillEntry.update_at = 1;
    fs.writeFileSync(skillManifest, JSON.stringify(stale, null, 2));

    const updated = await systemSkills.reconcileAllForActiveUser();
    expect(updated.find((r) => r.id === 'agent-creator')?.action).toBe('skipped');
    expect(updated.find((r) => r.id === 'skill-creator')?.action).toBe('updated');
  });

  it('restores a missing local skill even when the root manifest is current', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    await systemSkills.reconcileAllForActiveUser();
    const skillDir = paths.userSystemSkillDir(UID, 'agent-creator');
    fs.rmSync(skillDir, { recursive: true, force: true });

    const results = await systemSkills.reconcileAllForActiveUser();
    expect(results.find((r) => r.id === 'agent-creator')?.action).toBe('created');
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
  });

  it('retries failed reconciliation twice', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    const skillsRoot = paths.userSystemSkillsDir(UID);
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(skillsRoot), { recursive: true });
    fs.writeFileSync(skillsRoot, 'temporarily blocks directory creation');
    let checks = 0;

    const results = await systemSkills.reconcileAllForUserWithRetry(UID, {
      retries: 2,
      delayMs: 0,
      reason: 'test',
      shouldContinue: () => {
        checks += 1;
        if (checks === 3) fs.rmSync(skillsRoot, { force: true });
        return true;
      },
    });

    expect(checks).toBe(3);
    expect(results.find((r) => r.id === 'agent-creator')?.action).toBe('created');
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'agent-creator'), 'SKILL.md'))).toBe(true);
  });

  it('prompt rendering does not repair a missing local mirror', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    await systemSkills.reconcileAllForActiveUser();
    const skillDir = paths.userSystemSkillDir(UID, 'skill-creator');
    fs.rmSync(skillDir, { recursive: true, force: true });

    const registry = await import('../../../src/main/model/core-agent/skill-registry');
    const text = await registry.getSystemSkillsPromptBlock();
    expect(text).not.toContain('**skill-creator**');
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(false);
  });

  it('deletes local system skills that are no longer in the packaged manifest', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    await systemSkills.reconcileAllForActiveUser();
    const oldDir = paths.userSystemSkillDir(UID, 'old-creator');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'SKILL.md'), 'old');
    const manifestFile = paths.userSystemSkillsManifestFile(UID);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.push({ id: 'old-creator', update_at: 1 });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    const results = await systemSkills.reconcileAllForActiveUser();
    expect(results.find((r) => r.id === 'old-creator')?.action).toBe('deleted');
    expect(fs.existsSync(oldDir)).toBe(false);
    const nextManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(nextManifest.some((entry: any) => entry.id === 'old-creator')).toBe(false);
  });

  it('does not allow repo-shipped builtin skills to be added', async () => {
    const builtinSkillsDir = path.resolve(process.cwd(), 'src', 'builtin', 'skills');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile() && entry.name === 'SKILL.md') offenders.push(path.relative(process.cwd(), p));
      }
    };
    walk(builtinSkillsDir);
    expect(offenders).toEqual([]);
  });
});

describe('system creator skill contracts', () => {
  it('describes coding by its semantic use boundary rather than trigger keywords', () => {
    const fm = frontmatterOf(packagedSystemSkill('coding'));
    expect(fm).toContain('Use for implementing or changing code in an existing project');
    expect(fm).toContain('Do not use for explanation-only requests or disposable one-line scripts.');
    expect(fm).not.toContain('Triggers:');
  });

  it('keeps coding plans on the durable execution-plan tool', () => {
    const md = packagedSystemSkill('coding');
    expect(md).toContain('durable plan/TODO tool (`manage_execution_plan`)');
    expect(md).not.toContain('plan/TODO tool (`plan_set`)');
  });

  it('keeps creator SKILL.md frontmatter portable', () => {
    for (const id of ['agent-creator', 'skill-creator']) {
      const fm = frontmatterOf(packagedSystemSkill(id));
      expect(fm).toMatch(/^name:\s*/m);
      expect(fm).toMatch(/^description:\s*/m);
      expect(fm).not.toMatch(/^description_zh:/m);
      expect(fm).not.toMatch(/^description_en:/m);
      expect(fm).not.toMatch(/^category:/m);
    }
  });

  it('pins skill-creator import behavior to explicit intent and faithful restoration', () => {
    const md = packagedSystemSkill('skill-creator');
    expect(md).toContain('Explicit creation intent required');
    expect(md).toContain('Do **not** consult this skill for a plain "install this URL');
    expect(md).toContain('emit one `<skill>` container per source skill');
    expect(md).toContain('make the first source skill become the current import draft');
    expect(md).toContain('Do not merge multiple source skills into one Orkas skill');
    expect(md).toContain('Orkas-only metadata is emitted through metadata tags and stored in `_meta.json`');
    expect(md).toContain('If files besides `SKILL.md` are present, inspect the file tree and read the likely source docs first');
    expect(md).toContain('Do **not** ask the user whether the imported document should be used as a reference or merged into the skill');
    expect(md).toContain('Do **not** show source provenance by default');
  });

  it('pins agent-creator descriptions to current-language defaults and hidden provenance', () => {
    const md = packagedSystemSkill('agent-creator');
    expect(md).toContain('Use `<description_zh>` / `<description_en>` only when the user explicitly asks for multilingual/bilingual descriptions');
    expect(md).toContain('Default: one current-language description only');
    expect(md).toContain('Do **not** show source provenance by default');
    expect(md).not.toContain('Both are required');
  });

  it('keeps intentional creator-skill category and provenance rules in parity', () => {
    const agentCreator = packagedSystemSkill('agent-creator');
    const skillCreator = packagedSystemSkill('skill-creator');
    const categoryCodes = (md: string): string[] => {
      const section = md.match(/Pick one code from this fixed marketplace category list:[\s\S]*?\n\nMatch the primary domain/);
      expect(section).not.toBeNull();
      return Array.from(section![0].matchAll(/^\| `([^`]+)` \|/gm), (match) => match[1]);
    };
    const expectedCategories = ['education', 'ecommerce', 'rnd', 'creation', 'data', 'office', 'general'];
    const sharedClauses = [
      'Category sanity pass before final reply: if the chosen code is `general`',
      'Do **not** show source provenance by default.',
    ];

    expect(categoryCodes(agentCreator)).toEqual(expectedCategories);
    expect(categoryCodes(skillCreator)).toEqual(expectedCategories);
    for (const clause of sharedClauses) {
      expect(agentCreator).toContain(clause);
      expect(skillCreator).toContain(clause);
    }
  });
});
