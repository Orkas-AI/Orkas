import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SKILL_DESCRIPTION_AUTHORING_MAX_CHARS,
  SKILL_DESCRIPTION_AUTHORING_MIN_CHARS,
  SKILL_DESCRIPTION_ROSTER_MAX_CHARS,
} from '../../../src/main/util/skill-description-policy';

const UID = 'system-skills-user';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('../../../src/main/paths');
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

function packagedSystemSkillReference(id: string, reference: string): string {
  return fs.readFileSync(
    path.resolve(
      process.cwd(),
      'resources',
      'builtin',
      'system',
      'skills',
      id,
      'references',
      reference,
    ),
    'utf8',
  );
}

function packagedSystemSkillBundle(id: string): string {
  const root = path.resolve(process.cwd(), 'resources', 'builtin', 'system', 'skills', id);
  const refs = path.join(root, 'references');
  const files = [path.join(root, 'SKILL.md')];
  if (fs.existsSync(refs)) {
    files.push(...fs.readdirSync(refs).sort().map((name) => path.join(refs, name)));
  }
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
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
      ['package-installer', 'created'],
      ['skill-creator', 'created'],

    ]);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'agent-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(
      paths.userSystemSkillDir(UID, 'agent-creator'),
      'references',
      'llm-agent-fields.md',
    ))).toBe(true);
    expect(fs.existsSync(paths.userSystemSkillDir(UID, 'memory-manager'))).toBe(false);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'package-installer'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'skill-creator'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(
      paths.userSystemSkillDir(UID, 'skill-creator'),
      'references',
      'metadata.md',
    ))).toBe(true);
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
      ['package-installer', 'created'],
      ['skill-creator', 'created'],

    ]);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(loginUid, 'agent-creator'), 'SKILL.md'))).toBe(true);
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
    expect(skipped.map((r) => r.action)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(fs.existsSync(path.join(paths.userSystemSkillDir(UID, 'agent-creator'), '_system.json'))).toBe(false);

    const packagedSkillCreator = packagedSystemSkill('skill-creator');
    const installedSkillCreator = path.join(
      paths.userSystemSkillDir(UID, 'skill-creator'),
      'SKILL.md',
    );
    const installedMetadataReference = path.join(
      paths.userSystemSkillDir(UID, 'skill-creator'),
      'references',
      'metadata.md',
    );
    fs.writeFileSync(installedSkillCreator, 'stale local skill-creator content', 'utf8');
    fs.writeFileSync(installedMetadataReference, 'stale metadata reference', 'utf8');

    const skillManifest = paths.userSystemSkillsManifestFile(UID);
    const stale = JSON.parse(fs.readFileSync(skillManifest, 'utf8'));
    const skillEntry = stale.find((entry: any) => entry.id === 'skill-creator');
    skillEntry.update_at = 1;
    fs.writeFileSync(skillManifest, JSON.stringify(stale, null, 2));

    const updated = await systemSkills.reconcileAllForActiveUser();
    expect(updated.find((r) => r.id === 'agent-creator')?.action).toBe('skipped');
    expect(updated.find((r) => r.id === 'skill-creator')?.action).toBe('updated');
    expect(fs.readFileSync(installedSkillCreator, 'utf8')).toBe(packagedSkillCreator);
    expect(fs.readFileSync(installedMetadataReference, 'utf8'))
      .toBe(packagedSystemSkillReference('skill-creator', 'metadata.md'));
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

  it('deletes retired system skills from existing user mirrors', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    await systemSkills.reconcileAllForActiveUser();
    const retiredId = 'retired-system-skill';
    const oldDir = paths.userSystemSkillDir(UID, retiredId);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'SKILL.md'), 'old');
    const manifestFile = paths.userSystemSkillsManifestFile(UID);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.push({ id: retiredId, update_at: 1 });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    const results = await systemSkills.reconcileAllForActiveUser();
    expect(results.find((r) => r.id === retiredId)?.action).toBe('deleted');
    expect(fs.existsSync(oldDir)).toBe(false);
    const nextManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(nextManifest.some((entry: any) => entry.id === retiredId)).toBe(false);
  });

  it('removes retired task and memory Skills without losing saved memory or advertising stale references', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);
    const memory = await import('../../../src/main/features/memory');
    expect(memory.addEntry(UID, 'user', 'Prefer concise replies.').ok).toBe(true);
    const retired = ['autotask-creator', 'auto-tasks', 'project-tasks', 'todo-tasks', 'memory-manager'];
    for (const id of retired) {
      const dir = paths.userSystemSkillDir(UID, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: Old task protocol\n---\n`);
    }
    fs.writeFileSync(paths.userSystemSkillsManifestFile(UID), JSON.stringify(
      retired.map((id) => ({ id, update_at: 1 })),
    ));
    const results = await systemSkills.reconcileAllForUser(UID);
    const registry = await import('../../../src/main/model/core-agent/skill-registry');
    const bindings = new Map();
    const roster = await registry.getSystemSkillsPromptBlock(UID, bindings);
    for (const id of retired) {
      expect(results).toContainEqual({ id, action: 'deleted' });
      expect(fs.existsSync(paths.userSystemSkillDir(UID, id))).toBe(false);
      expect(roster).not.toContain(id);
      expect([...bindings.values()].some((binding) => binding.id === id)).toBe(false);
    }
    expect(roster).not.toContain('orkas-guide');
    expect(memory.listEntries(UID, 'user').entries).toEqual(['Prefer concise replies.']);
    expect((await systemSkills.reconcileAllForUser(UID)).every((result) => result.action === 'skipped')).toBe(true);
  });

  it('deletes an untracked system Skill directory that is absent from the packaged manifest', async () => {
    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    const paths = await import('../../../src/main/paths');
    users.activateUser(UID);

    await systemSkills.reconcileAllForActiveUser();
    const orphanId = 'untracked-system-skill';
    const orphanDir = paths.userSystemSkillDir(UID, orphanId);
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(
      path.join(orphanDir, 'SKILL.md'),
      '---\nname: untracked-system-skill\ndescription: must be removed\n---\n',
    );
    const manifestFile = paths.userSystemSkillsManifestFile(UID);
    const beforeManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(beforeManifest.some((entry: any) => entry.id === orphanId)).toBe(false);

    const results = await systemSkills.reconcileAllForActiveUser();
    expect(results.find((r) => r.id === orphanId)?.action).toBe('deleted');
    expect(fs.existsSync(orphanDir)).toBe(false);

    const registry = await import('../../../src/main/model/core-agent/skill-registry');
    expect(await registry.getSystemSkillsPromptBlock()).not.toContain('untracked-system-skill');
  });

  it('preserves local mirrors when the packaged manifest is unreadable, partial, or empty', async () => {
    const paths = await import('../../../src/main/paths');
    const localRoot = paths.userSystemSkillsDir(UID);
    const localId = 'kept-system-skill';
    const localDir = paths.userSystemSkillDir(UID, localId);
    const localManifestFile = paths.userSystemSkillsManifestFile(UID);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'SKILL.md'), 'local mirror must survive');
    fs.writeFileSync(localManifestFile, `${JSON.stringify([{ id: localId, update_at: 1 }], null, 2)}\n`);
    const localManifestBefore = fs.readFileSync(localManifestFile, 'utf8');

    const packagedRoot = path.join(tmpDir, 'broken-packaged-system-skills');
    const packagedManifestFile = path.join(packagedRoot, '_system.json');
    fs.mkdirSync(packagedRoot, { recursive: true });
    vi.doMock('../../../src/main/paths', async () => {
      const actual = await vi.importActual<typeof import('../../../src/main/paths')>(
        '../../../src/main/paths',
      );
      return {
        ...actual,
        packagedSystemSkillsDir: () => packagedRoot,
        packagedSystemSkillsManifestFile: () => packagedManifestFile,
      };
    });

    const users = await import('../../../src/main/features/users');
    const systemSkills = await import('../../../src/main/features/system_skills');
    users.activateUser(UID);
    const invalidSources = [
      '{not-json',
      JSON.stringify([
        { id: 'agent-creator', update_at: 1 },
        { id: '../invalid', update_at: 1 },
      ]),
      '[]',
    ];
    for (const source of invalidSources) {
      fs.writeFileSync(packagedManifestFile, source);
      const results = await systemSkills.reconcileAllForActiveUser();
      expect(results).toEqual([
        expect.objectContaining({ id: '*', action: 'invalid_manifest' }),
      ]);
      expect(fs.readFileSync(path.join(localDir, 'SKILL.md'), 'utf8')).toBe('local mirror must survive');
      expect(fs.readFileSync(localManifestFile, 'utf8')).toBe(localManifestBefore);
      expect(fs.existsSync(localRoot)).toBe(true);
    }
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

describe('system skill contracts', () => {
  it('keeps every platform-managed system Skill bilingual without a generic description', () => {
    const ids = [
      'agent-creator',
      'package-installer',
      'skill-creator',
    ];
    for (const id of ids) {
      const fm = frontmatterOf(packagedSystemSkill(id));
      expect(fm).toMatch(/^name:\s*/m);
      expect(fm).toMatch(/^description_zh:\s*\S/m);
      expect(fm).toMatch(/^description_en:\s*\S/m);
      expect(fm).not.toMatch(/^description:/m);
    }
  });

  it('keeps task tools available without packaged task Skills', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'resources/builtin/system/skills/_system.json'), 'utf8'));
    for (const retired of ['auto-tasks', 'todo-tasks']) {
      expect(manifest.map((row: any) => row.id)).not.toContain(retired);
    }
    const rules = fs.readFileSync(path.resolve(process.cwd(), 'src/main/prompts/chat_project_tasks_rules.md'), 'utf8');
    expect(rules).toContain('todo_tasks');
    expect(rules).toContain('depends_on');
    expect(rules).toContain('never complete blocked or unverified work');
    expect(rules).not.toContain('system skill');
  });

  it('authors one shared action-authority boundary instead of blanket reconfirmation', () => {
    const agentCreator = packagedSystemSkillBundle('agent-creator');
    const skillCreator = packagedSystemSkillBundle('skill-creator');

    for (const body of [agentCreator, skillCreator]) {
      expect(body).toContain('current user request authorizes that exact action');
      expect(body).toContain('unresolved target');
      expect(body).toContain('scope expansion');
      expect(body).toContain('platform-required confirmation');
      expect(body).not.toContain('confirm step before irreversible operations');
    }
  });

  it('pins skill-creator import behavior to explicit intent and faithful restoration', () => {
    const md = packagedSystemSkillBundle('skill-creator');
    expect(md).toContain('Explicit creation intent required');
    expect(md).toContain('Do **not** consult this skill for a plain "install this URL');
    expect(md).toContain('read the relevant source contents before authoring');
    expect(md).toContain('a filename plus a short request is not enough');
    expect(md).toContain('emit one `<skill>` container per source skill');
    expect(md).toContain('make the first source skill become the current import draft');
    expect(md).toContain('Do not merge multiple source skills into one Orkas skill');
    expect(md).toContain('Orkas-only metadata is emitted through metadata tags and stored in `_meta.json`');
    expect(md).toContain('If files besides `SKILL.md` are present, inspect the file tree and read the likely source docs first');
    expect(md).toContain('Do **not** ask the user whether the imported document should be used as a reference or merged into the skill');
    expect(md).toContain('Do **not** show source provenance by default');
    expect(md).toContain('`import_skill_package`');
    expect(md).toContain('Do not re-emit unchanged package files');
  });

  it('pins skill-creator description guidance to the runtime roster boundary', () => {
    const md = packagedSystemSkillBundle('skill-creator');
    expect(md).toContain('normally one or two sentences containing');
    expect(md).toContain('Core capability and delivery');
    expect(md).toContain('Typical user intent');
    expect(md).toContain('Necessary boundary');
    expect(md).toContain('without quoting sample requests or adding a separate keyword list');
    expect(md).toContain('When authoring or repairing a description, use the same compact routing index as SKILL.md frontmatter');
    expect(md).toContain(
      `aim for ${SKILL_DESCRIPTION_AUTHORING_MIN_CHARS}–${SKILL_DESCRIPTION_AUTHORING_MAX_CHARS} characters without padding`,
    );
    expect(md).toContain(`at or below ${SKILL_DESCRIPTION_ROSTER_MAX_CHARS} characters`);
    expect(md).toContain('preserve the complete description up to that boundary');
    // Roster overflow degrades lower-priority rows to their name; the guide
    // must not promise that a description always reaches the prompt.
    expect(md).toContain('when the roster exceeds its budget, lower-priority non-builtin entries are listed by name only and stay discoverable through `skill_search`');
    expect(md).toContain('Preserve faithful imported descriptions unless the user asks for a rewrite');
    expect(md).not.toMatch(/three-part dispatch format/i);
    expect(md).not.toContain('one-line function; suitable user phrasings; trigger words');
  });

  it('pins agent-creator descriptions to current-language defaults and hidden provenance', () => {
    const md = packagedSystemSkillBundle('agent-creator');
    expect(md).toContain('Use `<description_zh>` / `<description_en>` only when the user explicitly asks for multilingual/bilingual descriptions');
    expect(md).toContain('Default: one current-language description only');
    expect(md).toContain('Do **not** show source provenance by default');
    expect(md).toContain('No container, no mutation, no success claim');
    expect(md).toContain('the number of valid containers must equal the number of Agents');
    expect(md).toContain('Agent roles are not model runtimes');
    expect(md).toContain('Do not imitate or claim an unavailable provider');
    expect(md).toContain('current-turn attachments or referenced files');
    expect(md).toContain('concrete target before the current request');
    expect(md).toContain('not from the meta act of creating an Agent');
    expect(md).not.toContain('Both are required');
  });

  it('does not package the hosted-product Orkas guide', () => {
    expect(fs.existsSync(path.resolve(
      process.cwd(),
      'resources',
      'builtin',
      'system',
      'skills',
      'orkas-guide',
    ))).toBe(false);
  });

  it('keeps intentional creator-skill category and provenance rules in parity', () => {
    const agentCreator = packagedSystemSkillBundle('agent-creator');
    const skillCreator = packagedSystemSkillBundle('skill-creator');
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
