import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// OPEN-tier rendering (external packages + global roots) in
// `getSystemPromptBlock`. Companion to skill-registry.test.ts (trusted
// tier). Plan: docs/plans/open-ecosystem-architecture.md §A3/§B1; callers
// gate exposure via `includeOpenSources`.

let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
const TEST_UID = 'u1';

function customDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'skills');
}
function pkgsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'packages');
}
function homeDir(): string {
  return path.join(tmpDir, 'home');
}

function writeSkill(root: string, id: string, name: string, description: string) {
  const skillDir = path.join(root, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
}

function writePackage(
  name: string,
  skillRoots: string[],
  kind: 'skill' | 'cli' | 'both' = 'skill',
  enabled = true,
): void {
  fs.mkdirSync(path.join(pkgsDir(), name), { recursive: true });
  const registryPath = path.join(pkgsDir(), '_registry.json');
  let registry: any = { version: 1, packages: [] };
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { /* fresh */ }
  registry.packages.push({ name, kind, skill_roots: skillRoots, bin_entries: [], enabled });
  fs.mkdirSync(pkgsDir(), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skillreg-open-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Redirect homedir so global roots (~/.claude/skills, ~/.codex/skills)
  // resolve inside the sandbox, never the developer machine.
  process.env.HOME = homeDir();
  process.env.USERPROFILE = homeDir();
  fs.mkdirSync(homeDir(), { recursive: true });
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRegistry() {
  return import('../../../src/main/model/core-agent/skill-registry');
}

describe('skill-registry › open tier (includeOpenSources)', () => {
  it('excludes open-tier skills by default (agent workers / edit sessions)', async () => {
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).not.toContain('pkg-skill');
  });

  it('inlines enabled external-package skills (Source: external); global stays behind skill_search', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'custom skill');
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeOpenSources: true });
    // External-package skill is now inlined (registry-bounded, quality source).
    expect(text).toContain('pkg-skill');
    expect(text).toContain('Source: external');
    // Global tier is still lazy → the skill_search hint is still present.
    expect(text).toContain('skill_search');
    // Trusted entries unaffected.
    expect(text).toContain('**mine** (Source: custom)');
  });

  it('does not inline global-root skills (they stay behind skill_search)', async () => {
    const globalRoot = path.join(homeDir(), '.claude', 'skills');
    writeSkill(globalRoot, 'claude-skill', 'claude-skill', 'global skill');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeOpenSources: true });
    expect(text).not.toContain('claude-skill');
    expect(text).toContain('skill_search');
  });

  it('renders a user-forced global skill even when an allowlist is active', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'custom skill');
    const globalRoot = path.join(homeDir(), '.claude', 'skills');
    writeSkill(globalRoot, 'claude-skill', 'claude-skill', 'global skill');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      allowlist: ['mine'],
      forceOpenSkillRefs: ['claude-skill'],
    });
    expect(text).toContain('**mine** (Source: custom)');
    expect(text).toContain('**claude-skill** (Source: global)');
    expect(text).not.toContain('skill_search');
  });

  it('omits the skill_search hint when open sources are not requested', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'custom skill');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).not.toContain('skill_search');
    expect(text).toContain('**mine** (Source: custom)');
  });

  it('suppresses the open-tier hint under an allowlist (skill_list semantics)', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'custom skill');
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeOpenSources: true, allowlist: ['mine', 'pkg-skill'] });
    expect(text).toContain('mine');
    expect(text).not.toContain('pkg-skill');
    expect(text).not.toContain('skill_search');
  });

  it('inlines enabled package skills but never disabled ones, even for top-level roots', async () => {
    writePackage('onpack', ['.']);
    writePackage('offpack', ['.'], 'skill', false);
    writeSkill(pkgsDir(), 'onpack', 'onpack', 'enabled package');
    writeSkill(pkgsDir(), 'offpack', 'offpack', 'disabled package');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeOpenSources: true });
    expect(text).toContain('skill_search');
    expect(text).toContain('**onpack**');           // enabled → inlined
    expect(text).toContain('enabled package');
    expect(text).not.toContain('offpack');           // disabled → excluded
    expect(text).not.toContain('disabled package');
  });

  it('listOpenSkillsByTier keeps external and global separate (no cross-tier dedupe)', async () => {
    // Same id in BOTH an installed package and a global folder. The bridge
    // listing folds these into one (display-name dedupe); the UI listing must
    // surface both so each provenance is visible in its own panel section.
    writePackage('mypack', ['skills'], 'both');
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'animejs', 'animejs', 'from package');
    writeSkill(path.join(homeDir(), '.claude', 'skills'), 'animejs', 'animejs', 'from global');
    writeSkill(path.join(homeDir(), '.claude', 'skills'), 'global-only', 'global-only', 'global solo');

    const { listOpenSkillsByTier } = await loadRegistry();
    const { external, global } = await listOpenSkillsByTier(TEST_UID);

    expect(external.map((s) => s.id)).toEqual(['animejs']);
    expect(external[0].source).toBe('external');
    expect(external[0].package_name).toBe('mypack');
    expect(external[0].package_kind).toBe('both');
    expect(external[0].package_enabled).toBe(true);
    // Global keeps its own copy of `animejs` AND the global-only skill.
    expect(global.map((s) => s.id).sort()).toEqual(['animejs', 'global-only']);
    expect(global.every((s) => s.source === 'global')).toBe(true);
    // Each row carries the dir of its own tier, not the other's.
    expect(external[0].dir).toContain(path.join('mypack', 'skills', 'animejs'));
    expect(global.find((s) => s.id === 'animejs')!.dir).toContain(path.join('.claude', 'skills', 'animejs'));
  });

  it('listOpenSkillsByTier keeps disabled package skills visible for the UI', async () => {
    writePackage('offpack', ['skills'], 'skill', false);
    writeSkill(path.join(pkgsDir(), 'offpack', 'skills'), 'off-skill', 'off-skill', 'disabled package skill');

    const { listOpenSkillsByTier } = await loadRegistry();
    const { external } = await listOpenSkillsByTier(TEST_UID);

    expect(external.map((s) => s.id)).toEqual(['off-skill']);
    expect(external[0].package_name).toBe('offpack');
    expect(external[0].package_enabled).toBe(false);
  });

  it('listOpenSkillsByTier returns empty global when the preference is off', async () => {
    writeSkill(path.join(homeDir(), '.claude', 'skills'), 'claude-skill', 'claude-skill', 'global skill');
    const config = await import('../../../src/main/features/config');
    config.setGlobalSkillRootsEnabled(false);

    const { listOpenSkillsByTier } = await loadRegistry();
    const { global } = await listOpenSkillsByTier(TEST_UID);
    expect(global).toEqual([]);
  });

  it('openSkillReadRoots returns existing open dirs for the read scope', async () => {
    writePackage('mypack', ['skills']);
    fs.mkdirSync(path.join(pkgsDir(), 'mypack', 'skills'), { recursive: true });
    const globalRoot = path.join(homeDir(), '.claude', 'skills');
    fs.mkdirSync(globalRoot, { recursive: true });

    const { openSkillReadRoots } = await loadRegistry();
    const roots = openSkillReadRoots(TEST_UID);
    expect(roots).toContain(path.resolve(path.join(pkgsDir(), 'mypack', 'skills')));
    expect(roots).toContain(globalRoot);
    // ~/.codex/skills doesn't exist in the sandbox → filtered out.
    expect(roots).not.toContain(path.join(homeDir(), '.codex', 'skills'));
  });

  it('listSkillSpecsForAgentMetadata includes trusted + enabled external, but not global', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'trusted custom');
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');
    writeSkill(path.join(homeDir(), '.claude', 'skills'), 'global-skill', 'global-skill', 'global skill');

    const { listSkillSpecsForAgentMetadata } = await loadRegistry();
    const ids = (await listSkillSpecsForAgentMetadata(TEST_UID)).map((s) => s.id);

    expect(ids).toContain('mine');
    expect(ids).toContain('pkg-skill');
    expect(ids).not.toContain('global-skill');
  });
});

describe('skill-registry › searchOpenTierSkills (global tier only)', () => {
  // External packages are now inlined into the prompt, so search covers ONLY
  // the still-lazy global-folder tier.
  const G = () => path.join(homeDir(), '.claude', 'skills');

  it('ranks query matches and excludes non-matches; reports total_matched', async () => {
    writeSkill(G(), 'alpha', 'alpha', 'handles translation tasks');
    writeSkill(G(), 'beta', 'beta', 'image editing helper');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, 'translation', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['alpha']);
    expect(res.total_matched).toBe(1);
    expect(res.returned).toBe(1);
  });

  it('excludes external-package skills (now inlined, not searched)', async () => {
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'extonly', 'extonly', 'shared capability');
    writeSkill(G(), 'globonly', 'globonly', 'shared capability');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, 'shared', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['globonly']); // external dropped from search
  });

  it('drops global ids that collide with a trusted id (trusted wins)', async () => {
    writeSkill(customDir(), 'dup', 'dup', 'trusted dup');
    writeSkill(G(), 'dup', 'dup', 'global dup');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, 'dup', 8);
    expect(res.rows).toEqual([]);
    expect(res.total_matched).toBe(0);
  });

  it('filters disabled ids', async () => {
    writeSkill(G(), 'gamma', 'gamma', 'reporting tool');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, 'reporting', 8, ['gamma']);
    expect(res.rows).toEqual([]);
  });

  it('caps rows to limit while total_matched reflects the full match count', async () => {
    for (const id of ['t1', 't2', 't3', 't4', 't5']) writeSkill(G(), id, id, 'shared tool capability');
    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, 'tool', 2);
    expect(res.returned).toBe(2);
    expect(res.rows.length).toBe(2);
    expect(res.total_matched).toBe(5);
  });

  it('empty query returns a bounded list (all matches, name-ordered)', async () => {
    writeSkill(G(), 'zeta', 'zeta', 'one');
    writeSkill(G(), 'alpha', 'alpha', 'two');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, '', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['alpha', 'zeta']);
    expect(res.total_matched).toBe(2);
  });

  it('matches a Chinese query against Chinese skill content (CJK substring)', async () => {
    writeSkill(G(), 'fanyi', '翻译助手', '把文本翻译成多国语言');
    writeSkill(G(), 'tianqi', '天气查询', '查询城市天气预报');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, '翻译', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['fanyi']);
  });

  it('weighs a name hit above a description-only hit', async () => {
    writeSkill(G(), 'report-builder', 'report-builder', 'misc helper');
    writeSkill(G(), 'misc-tool', 'misc-tool', 'builds a report');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, 'report', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['report-builder', 'misc-tool']);
  });

  it('clamps limit to the 1..20 range', async () => {
    for (let i = 0; i < 22; i += 1) writeSkill(G(), `cap${i}`, `cap${i}`, 'shared cap tool');
    const { searchOpenTierSkills } = await loadRegistry();
    const high = await searchOpenTierSkills(TEST_UID, 'shared', 999);
    expect(high.returned).toBe(20); // capped at max
    expect(high.total_matched).toBe(22);
    const low = await searchOpenTierSkills(TEST_UID, 'shared', 1);
    expect(low.returned).toBe(1);
  });

  it('labels source=global and points read_path at the SKILL.md', async () => {
    writeSkill(G(), 'glob1', 'glob1', 'shared capability');

    const { searchOpenTierSkills } = await loadRegistry();
    const res = await searchOpenTierSkills(TEST_UID, 'shared', 8);
    const glob = res.rows.find((r) => r.id === 'glob1')!;
    expect(glob.source).toBe('global');
    expect(glob.read_path).toContain(path.join('.claude', 'skills', 'glob1', 'SKILL.md'));
  });
});

describe('skill-registry › listSkillsForBridge (external CLI surface)', () => {
  it('serves trusted + external packages but NEVER global roots', async () => {
    // Global roots are enabled by default; the CLI reads its own
    // ~/.claude|.codex/skills natively, so the bridge must not re-expose
    // them (would double every global skill: native + bridge).
    writeSkill(customDir(), 'my-skill', 'my-skill', 'trusted custom');
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');
    writeSkill(path.join(homeDir(), '.claude', 'skills'), 'claude-skill', 'claude-skill', 'claude global');
    writeSkill(path.join(homeDir(), '.codex', 'skills'), 'codex-skill', 'codex-skill', 'codex global');

    const { listSkillsForBridge } = await loadRegistry();
    const ids = (await listSkillsForBridge(TEST_UID)).map((s) => s.id);

    expect(ids).toContain('my-skill');   // trusted
    expect(ids).toContain('pkg-skill');  // external package — the bridge's value-add
    expect(ids).not.toContain('claude-skill'); // global root → excluded
    expect(ids).not.toContain('codex-skill');  // global root → excluded
  });

  it('labels an external-package skill as source=external', async () => {
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');
    const { listSkillsForBridge } = await loadRegistry();
    const rows = await listSkillsForBridge(TEST_UID);
    expect(rows.find((s) => s.id === 'pkg-skill')!.source).toBe('external');
  });
});

describe('skill-registry › CLI-package companion skills', () => {
  function writeCompanion(pkg: string, name: string, description: string): void {
    writeSkill(path.join(tmpDir, TEST_UID, 'local', 'package_skills'), pkg, name, description);
  }

  it('inlines a companion for an enabled CLI package as Source: external', async () => {
    writePackage('crawl4ai', [], 'cli');
    writeCompanion('crawl4ai', 'crawl4ai', 'drive the crawl4ai CLI');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeOpenSources: true });
    expect(text).toContain('drive the crawl4ai CLI');
    expect(text).toContain('Source: external');
  });

  it('drops a companion whose package is not in the registry (orphan)', async () => {
    // Companion on disk but no matching registry package → must not surface.
    writeCompanion('ghostpkg', 'ghostpkg', 'orphaned companion');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeOpenSources: true });
    expect(text).not.toContain('orphaned companion');
  });

  it('surfaces a companion in the UI listing with its package kind', async () => {
    writePackage('crawl4ai', [], 'cli');
    writeCompanion('crawl4ai', 'crawl4ai', 'drive the crawl4ai CLI');
    const { listOpenSkillsByTier } = await loadRegistry();
    const { external } = await listOpenSkillsByTier(TEST_UID);
    const row = external.find((s) => s.id === 'crawl4ai');
    expect(row).toBeTruthy();
    expect(row!.package_name).toBe('crawl4ai');
    expect(row!.package_kind).toBe('cli');
  });
});
