import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
const io = vi.hoisted(() => ({ copyFile: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), copyFile: io.copyFile,
}));
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previous: string | undefined;
let previousBuiltin: string | undefined;
const warnings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: warnings }) }));
vi.mock('../../../src/main/model/core-agent/skill-registry', () => ({ invalidateSkills: vi.fn(async () => {}) }));
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  io.copyFile.mockReset().mockImplementation(actual.copyFile);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-system-startup-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  previousBuiltin = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  process.env.ORKAS_BUILTIN_ROOT = path.join(root, 'builtin');
  vi.resetModules(); warnings.mockClear();
  for (const id of ['alpha', 'beta']) {
    const dir = path.join(root, 'builtin/system/skills', id);
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `${id} new`);
    fs.writeFileSync(path.join(dir, 'references/detail.md'), `${id} reference`);
  }
  fs.writeFileSync(path.join(root, 'builtin/system/skills/_system.json'), JSON.stringify([
    { id: 'alpha', update_at: 2 }, { id: 'beta', update_at: 2 },
  ]));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  if (previousBuiltin === undefined) delete process.env.ORKAS_BUILTIN_ROOT;
  else process.env.ORKAS_BUILTIN_ROOT = previousBuiltin;
  fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const paths = await import('../../../src/main/paths');
  const skills = await import('../../../src/main/features/system_skills');
  return { paths, skills };
}

describe('System Skill startup responsiveness and account continuity', () => {
  it('yields to the event loop before publishing the first directory, then publishes exact content', async () => {
    const { paths, skills } = await fixture();
    const run = skills.reconcileAllForUser('account-a');
    const publishedBeforeYield = await new Promise<boolean>((resolve) => setImmediate(() => {
      resolve(fs.existsSync(path.join(paths.userSystemSkillDir('account-a', 'alpha'), 'SKILL.md')));
    }));
    await run;
    expect(publishedBeforeYield).toBe(false);
    expect(fs.readFileSync(path.join(paths.userSystemSkillDir('account-a', 'alpha'), 'references/detail.md'), 'utf8')).toBe('alpha reference');
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'account-switch'] as const)('keeps the previous mirror when %s occurs during copying and can retry', async (kind) => {
    const { paths, skills } = await fixture();
    const target = paths.userSystemSkillDir('account-a', 'alpha');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'alpha previous');
    fs.writeFileSync(paths.userSystemSkillsManifestFile('account-a'), JSON.stringify([{ id: 'alpha', update_at: 1 }]));
    const controller = new AbortController(); let active = 'account-a';
    const copy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile;
    io.copyFile.mockImplementation(async (...args) => {
      await copy(...args);
      if (kind === 'cancel') controller.abort(); else active = 'account-b';
    });
    await skills.reconcileAllForUserWithRetry('account-a', {
      retries: 0, shouldContinue: () => !controller.signal.aborted && active === 'account-a',
    });
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('alpha previous');
    expect(fs.existsSync(paths.userSystemSkillDir('account-a', 'beta'))).toBe(false);
    expect(fs.existsSync(paths.userSystemSkillsDir('account-b'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.userSystemSkillsManifestFile('account-a'), 'utf8'))).toEqual([{ id: 'alpha', update_at: 1 }]);
    expect(fs.readdirSync(paths.userSystemSkillsDir('account-a')).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
    io.copyFile.mockImplementation(copy);
    await skills.reconcileAllForUser('account-a');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('alpha new');
    expect(fs.readFileSync(path.join(paths.userSystemSkillDir('account-a', 'beta'), 'SKILL.md'), 'utf8')).toBe('beta new');
  });

  it('retains the old mirror on copy failure and recovers without changing version rules', async () => {
    const { paths, skills } = await fixture();
    const target = paths.userSystemSkillDir('account-a', 'alpha');
    fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'SKILL.md'), 'previous');
    const copy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile;
    io.copyFile.mockRejectedValueOnce(Object.assign(new Error('fixture copy denied'), { code: 'EACCES' }));
    const result = await skills.reconcileAllForUser('account-a');
    expect(result).toContainEqual(expect.objectContaining({ id: 'alpha', action: 'failed' }));
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('previous');
    expect(warnings).toHaveBeenCalledOnce();
    vi.mocked(fsp.copyFile).mockImplementation(copy);
    await skills.reconcileAllForUser('account-a');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('alpha new');
    expect((await skills.reconcileAllForUser('account-a')).map((row) => row.action)).toEqual(['skipped', 'skipped']);
  });
});
