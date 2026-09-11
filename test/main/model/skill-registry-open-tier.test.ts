import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Lazy shared-Skill rendering/search policy. Companion to
// skill-registry.test.ts (resident trusted tier). The owning runtime contract
// is docs/architecture/skill-engineering-contract.md.

let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
const TEST_UID = 'u1';

function customDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'skills');
}
function marketplaceDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'marketplace', 'skills');
}
function systemDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'system', 'skills');
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

function writeSkillFrontmatter(
  root: string,
  id: string,
  fields: Record<string, string>,
  installMeta?: Record<string, unknown>,
): void {
  const skillDir = path.join(root, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    '---',
    'body',
  ].join('\n'));
  if (installMeta) fs.writeFileSync(path.join(skillDir, '_install.json'), JSON.stringify(installMeta));
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

describe('skill-registry › lazy shared Skill prompt policy', () => {
  it('keeps package/global Skills out of the resident roster by default', async () => {
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).not.toContain('pkg-skill');
  });

  it('keeps package and global Skills lazy while advertising one search path', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'custom skill');
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeSkillSearchHint: true });
    expect(text).not.toContain('pkg-skill');
    expect(text).not.toContain('Source: external');
    expect(text).toContain('skill_search');
    // Trusted entries unaffected.
    expect(text).toContain('**mine** (Source: custom)');
  });

  it('does not inline global-root skills (they stay behind skill_search)', async () => {
    const globalRoot = path.join(homeDir(), '.claude', 'skills');
    writeSkill(globalRoot, 'claude-skill', 'claude-skill', 'global skill');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeSkillSearchHint: true });
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

  it('honors the selected source when external and global tiers share one id', async () => {
    writePackage('same-id-package', ['skills']);
    writeSkill(
      path.join(pkgsDir(), 'same-id-package', 'skills'),
      'same-id-skill',
      'External Same Id',
      'external same-id contract',
    );
    writeSkill(
      path.join(homeDir(), '.claude', 'skills'),
      'same-id-skill',
      'Global Same Id',
      'global same-id contract',
    );

    const { getSystemPromptBlock } = await loadRegistry();
    const runtimeBindings = new Map();
    const globalText = await getSystemPromptBlock({
      allowlist: [],
      forceOpenSkillRefs: [{ id: 'same-id-skill', source: 'global' }],
      runtimeBindings,
    });

    expect(globalText).toContain('**Global Same Id** (Source: global');
    expect(globalText).toContain('global same-id contract');
    expect(globalText).not.toContain('External Same Id');
    expect([...runtimeBindings.values()]).toContainEqual(expect.objectContaining({
      id: 'same-id-skill',
      name: 'Global Same Id',
      source: 'global',
    }));

    const externalText = await getSystemPromptBlock({
      allowlist: [],
      forceOpenSkillRefs: [{ id: 'same-id-skill', source: 'external' }],
    });
    expect(externalText).toContain('**External Same Id** (Source: external');
    expect(externalText).not.toContain('Global Same Id');
  });

  it('retains two explicitly selected tiers that share one id', async () => {
    writePackage('same-id-package', ['skills']);
    writeSkill(
      path.join(pkgsDir(), 'same-id-package', 'skills'),
      'same-id-skill',
      'External Same Id',
      'external selected contract',
    );
    writeSkill(
      path.join(homeDir(), '.claude', 'skills'),
      'same-id-skill',
      'Global Same Id',
      'global selected contract',
    );

    const { getSystemPromptBlock } = await loadRegistry();
    const runtimeBindings = new Map();
    const text = await getSystemPromptBlock({
      allowlist: [],
      forceOpenSkillRefs: [
        { id: 'same-id-skill', source: 'external' },
        { id: 'same-id-skill', source: 'global' },
      ],
      runtimeBindings,
    });

    expect(text).toContain('**External Same Id** (Source: external');
    expect(text).toContain('**Global Same Id** (Source: global');
    expect([...runtimeBindings.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'same-id-skill', source: 'external' }),
      expect.objectContaining({ id: 'same-id-skill', source: 'global' }),
    ]));
    expect(new Set(runtimeBindings.keys()).size).toBe(2);
  });

  it('does not substitute another tier when an exact selected source disappeared', async () => {
    writePackage('external-only-package', ['skills']);
    writeSkill(
      path.join(pkgsDir(), 'external-only-package', 'skills'),
      'external-only',
      'External Only',
      'must not substitute',
    );

    const { getSystemPromptBlock } = await loadRegistry();
    const exactMissing = await getSystemPromptBlock({
      allowlist: [],
      forceOpenSkillRefs: [{ id: 'external-only', source: 'global' }],
    });
    expect(exactMissing).toBe('');

    const legacy = await getSystemPromptBlock({
      allowlist: [],
      forceOpenSkillRefs: ['external-only'],
    });
    expect(legacy).toContain('**External Only** (Source: external');
  });

  it('does not use a same-source display-name match for a stale source-aware id', async () => {
    writeSkill(
      path.join(homeDir(), '.claude', 'skills'),
      'replacement-id',
      'Old Display Name',
      'replacement must remain unselected',
    );

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      allowlist: [],
      forceOpenSkillRefs: [{ id: 'removed-id', name: 'Old Display Name', source: 'global' }],
    });
    expect(text).toBe('');
  });

  it('omits the skill_search hint when open sources are not requested', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'custom skill');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).not.toContain('skill_search');
    expect(text).toContain('**mine** (Source: custom)');
  });

  it('keeps search available when an Agent-style dependency list is present', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'custom skill');
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeSkillSearchHint: true, allowlist: ['mine', 'pkg-skill'] });
    expect(text).toContain('mine');
    expect(text).not.toContain('pkg-skill');
    expect(text).toContain('skill_search');
  });

  it('keeps package Skills out of the resident prompt regardless of package state', async () => {
    writePackage('onpack', ['.']);
    writePackage('offpack', ['.'], 'skill', false);
    writeSkill(pkgsDir(), 'onpack', 'onpack', 'enabled package');
    writeSkill(pkgsDir(), 'offpack', 'offpack', 'disabled package');

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeSkillSearchHint: true });
    expect(text).toContain('skill_search');
    expect(text).not.toContain('**onpack**');
    expect(text).not.toContain('enabled package');
    expect(text).not.toContain('offpack');
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

  it('listSkillSpecsForAgentMetadata keeps Agent metadata trusted/private only', async () => {
    writeSkill(customDir(), 'mine', 'mine', 'trusted custom');
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'pkg-skill', 'pkg-skill', 'from package');
    writeSkill(path.join(homeDir(), '.claude', 'skills'), 'global-skill', 'global-skill', 'global skill');

    const { listSkillSpecsForAgentMetadata } = await loadRegistry();
    const ids = (await listSkillSpecsForAgentMetadata(TEST_UID)).map((s) => s.id);

    expect(ids).toContain('mine');
    expect(ids).not.toContain('pkg-skill');
    expect(ids).not.toContain('global-skill');
  });
});

describe('skill-registry › searchAvailableSkills', () => {
  const G = () => path.join(homeDir(), '.claude', 'skills');

  it('ranks query matches and excludes non-matches; reports total_matched', async () => {
    writeSkill(G(), 'alpha', 'alpha', 'handles translation tasks');
    writeSkill(G(), 'beta', 'beta', 'image editing helper');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'translation', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['alpha']);
    expect(res.total_matched).toBe(1);
    expect(res.returned).toBe(1);
  });

  it('searches enabled external-package and global Skills', async () => {
    writePackage('mypack', ['skills']);
    writeSkill(path.join(pkgsDir(), 'mypack', 'skills'), 'extonly', 'extonly', 'shared capability');
    writeSkill(G(), 'globonly', 'globonly', 'shared capability');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'shared', 8);
    expect(res.rows.map((r) => [r.id, r.source])).toEqual([
      ['extonly', 'external'],
      ['globonly', 'global'],
    ]);
  });

  it('excludes disabled packages and disabled global roots from search', async () => {
    writePackage('offpack', ['skills'], 'skill', false);
    writeSkill(path.join(pkgsDir(), 'offpack', 'skills'), 'off-skill', 'Off Skill', 'unique dormant capability');
    writeSkill(G(), 'global-off', 'Global Off', 'unique dormant capability');
    const config = await import('../../../src/main/features/config');
    config.setGlobalSkillRootsEnabled(false);

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'unique dormant capability', 8);
    expect(res.rows).toEqual([]);
    expect(res.total_matched).toBe(0);
  });

  it('searches custom Skills and lets them win a global id collision', async () => {
    writeSkill(customDir(), 'dup', 'dup', 'trusted dup');
    writeSkill(G(), 'dup', 'dup', 'global dup');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'dup', 8);
    expect(res.rows).toEqual([expect.objectContaining({ id: 'dup', source: 'custom' })]);
    expect(res.total_matched).toBe(1);
  });

  it('searches platform builtins, platform-installed, and custom Skills', async () => {
    writeSkillFrontmatter(
      marketplaceDir(),
      'builtin-one',
      { name: 'Builtin One', description: 'resident chart helper' },
      { seed_source: 'builtin' },
    );
    writeSkill(marketplaceDir(), 'installed-one', 'Installed One', 'searchable chart helper');
    writeSkill(customDir(), 'custom-one', 'Custom One', 'searchable chart helper');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'chart helper', 8);
    expect(res.rows.map((row) => [row.id, row.source])).toEqual([
      ['builtin-one', 'builtin'],
      ['installed-one', 'platform'],
      ['custom-one', 'custom'],
    ]);
  });

  it('excludes owner-tagged Skills from every actor search', async () => {
    writeSkillFrontmatter(customDir(), 'private-shared-path', {
      name: 'Private Shared Path',
      description: 'confidential analysis protocol',
      ownerAgent: 'agent-a',
    });
    writeSkill(customDir(), 'public-analysis', 'Public Analysis', 'public analysis protocol');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'analysis protocol', 8);
    expect(res.rows.map((row) => row.id)).toEqual(['public-analysis']);
  });

  it('never searches System Skills', async () => {
    writeSkill(systemDir(), 'system-secret', 'System Secret', 'unique system authoring protocol');
    writeSkill(customDir(), 'shared-authoring', 'Shared Authoring', 'unique shared authoring protocol');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'unique authoring protocol', 8);
    expect(res.rows.map((row) => row.id)).toEqual(['shared-authoring']);
  });

  it('filters disabled ids', async () => {
    writeSkill(G(), 'gamma', 'gamma', 'reporting tool');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'reporting', 8, ['gamma']);
    expect(res.rows).toEqual([]);
  });

  it('can exclude Skills already resident in the current runner', async () => {
    writeSkill(G(), 'resident-one', 'Resident One', 'shared reporting capability');
    writeSkill(customDir(), 'resident-alias', 'Resident One', 'same-name lower-priority duplicate');
    writeSkill(G(), 'lazy-one', 'Lazy One', 'shared reporting capability');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(
      TEST_UID,
      'reporting',
      8,
      undefined,
      0,
      ['resident-one', 'Resident One'],
    );
    expect(res.rows.map((row) => row.id)).toEqual(['lazy-one']);
  });

  it('caps rows to limit while total_matched reflects the full match count', async () => {
    for (const id of ['t1', 't2', 't3', 't4', 't5']) writeSkill(G(), id, id, 'shared tool capability');
    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'tool', 2);
    expect(res.returned).toBe(2);
    expect(res.rows.length).toBe(2);
    expect(res.total_matched).toBe(5);
  });

  it('pages the stable ranking by offset without duplicates or omissions', async () => {
    for (const id of ['page-a', 'page-b', 'page-c', 'page-d', 'page-e']) {
      writeSkill(G(), id, id, 'shared paged capability');
    }
    const { searchAvailableSkills } = await loadRegistry();

    const first = await searchAvailableSkills(TEST_UID, 'paged', 2, undefined, 0);
    const second = await searchAvailableSkills(TEST_UID, 'paged', 2, undefined, 2);
    const last = await searchAvailableSkills(TEST_UID, 'paged', 2, undefined, 4);
    const beyond = await searchAvailableSkills(TEST_UID, 'paged', 2, undefined, 5);

    expect(first.rows.map((row) => row.id)).toEqual(['page-a', 'page-b']);
    expect(second.rows.map((row) => row.id)).toEqual(['page-c', 'page-d']);
    expect(last.rows.map((row) => row.id)).toEqual(['page-e']);
    expect(beyond.rows).toEqual([]);
    expect([first, second, last, beyond].map((page) => page.total_matched)).toEqual([5, 5, 5, 5]);
  });

  it('rejects an invalid offset instead of silently changing the requested page', async () => {
    const { searchAvailableSkills } = await loadRegistry();
    await expect(searchAvailableSkills(TEST_UID, '', 2, undefined, -1))
      .rejects.toThrow('offset must be a non-negative safe integer');
  });

  it('empty query returns a bounded list (all matches, name-ordered)', async () => {
    writeSkill(G(), 'zeta', 'zeta', 'one');
    writeSkill(G(), 'alpha', 'alpha', 'two');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, '', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['alpha', 'zeta']);
    expect(res.total_matched).toBe(2);
  });

  it('matches a Chinese query against Chinese skill content (CJK substring)', async () => {
    writeSkill(G(), 'fanyi', '翻译助手', '把文本翻译成多国语言');
    writeSkill(G(), 'tianqi', '天气查询', '查询城市天气预报');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, '翻译', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['fanyi']);
  });

  it('matches separated Chinese concepts through deterministic Han bigrams', async () => {
    writeSkill(G(), 'analysis-cn', '洞察助手', '完成数据清洗以及统计分析');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, '数据分析', 8);
    expect(res.rows.map((row) => row.id)).toEqual(['analysis-cn']);
  });

  it('weighs a name hit above a description-only hit', async () => {
    writeSkill(G(), 'report-builder', 'report-builder', 'misc helper');
    writeSkill(G(), 'misc-tool', 'misc-tool', 'builds a report');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'report', 8);
    expect(res.rows.map((r) => r.id)).toEqual(['report-builder', 'misc-tool']);
  });

  it('ranks an exact lower-tier name above a higher-tier description-only match', async () => {
    writeSkillFrontmatter(
      marketplaceDir(),
      'builtin-helper',
      { name: 'General Helper', description: 'supports exact quarterly audit workflows' },
      { seed_source: 'builtin' },
    );
    writeSkill(G(), 'quarterly-audit', 'quarterly-audit', 'specialized workflow');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'quarterly-audit', 8);
    expect(res.rows.map((row) => row.id)).toEqual(['quarterly-audit', 'builtin-helper']);
  });

  it('normalizes case, surrounding whitespace, and full-width Latin query text', async () => {
    writeSkill(G(), 'risk-audit', 'Risk-Audit', 'quarterly review workflow');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, '  ＲＩＳＫ－ＡＵＤＩＴ  ', 8);
    expect(res.rows.map((row) => row.id)).toEqual(['risk-audit']);
  });

  it('matches either localized description independent of the current display language', async () => {
    writeSkillFrontmatter(G(), 'bilingual-risk', {
      name: 'Bilingual Risk',
      description_zh: '供应链压力情景评估',
      description_en: 'supply chain stress scenario assessment',
    });

    const { searchAvailableSkills } = await loadRegistry();
    const chinese = await searchAvailableSkills(TEST_UID, '压力情景', 8);
    const english = await searchAvailableSkills(TEST_UID, 'stress scenario', 8);
    expect(chinese.rows.map((row) => row.id)).toEqual(['bilingual-risk']);
    expect(english.rows.map((row) => row.id)).toEqual(['bilingual-risk']);
  });

  it('refreshes search results after a Skill is added under an already-cached root', async () => {
    writeSkill(G(), 'before-refresh', 'Before Refresh', 'catalog freshness marker');
    const { searchAvailableSkills } = await loadRegistry();
    const before = await searchAvailableSkills(TEST_UID, 'freshness marker', 8);
    expect(before.rows.map((row) => row.id)).toEqual(['before-refresh']);

    writeSkill(G(), 'after-refresh', 'After Refresh', 'catalog freshness marker');
    const after = await searchAvailableSkills(TEST_UID, 'freshness marker', 8);
    expect(after.rows.map((row) => row.id)).toEqual(['after-refresh', 'before-refresh']);
  });

  it('clamps limit to the compact 1..10 range', async () => {
    for (let i = 0; i < 22; i += 1) writeSkill(G(), `cap${i}`, `cap${i}`, 'shared cap tool');
    const { searchAvailableSkills } = await loadRegistry();
    const high = await searchAvailableSkills(TEST_UID, 'shared', 999);
    expect(high.returned).toBe(10); // capped at max
    expect(high.total_matched).toBe(22);
    const low = await searchAvailableSkills(TEST_UID, 'shared', 1);
    expect(low.returned).toBe(1);
  });

  it('returns at most five rows by default while preserving host-side match counts', async () => {
    for (let i = 0; i < 7; i += 1) writeSkill(G(), `default${i}`, `default${i}`, 'default limit tool');
    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'default');
    expect(res.returned).toBe(5);
    expect(res.total_matched).toBe(7);
  });

  it('labels source=global and points read_path at the SKILL.md', async () => {
    writeSkill(G(), 'glob1', 'glob1', 'shared capability');

    const { searchAvailableSkills } = await loadRegistry();
    const res = await searchAvailableSkills(TEST_UID, 'shared', 8);
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

  it('finds a companion for an enabled CLI package through search', async () => {
    writePackage('crawl4ai', [], 'cli');
    writeCompanion('crawl4ai', 'crawl4ai', 'drive the crawl4ai CLI');
    const { getSystemPromptBlock, searchAvailableSkills } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeSkillSearchHint: true });
    expect(text).not.toContain('drive the crawl4ai CLI');
    const res = await searchAvailableSkills(TEST_UID, 'crawl4ai', 8);
    expect(res.rows).toEqual([expect.objectContaining({ id: 'crawl4ai', source: 'external' })]);
  });

  it('drops a companion whose package is not in the registry (orphan)', async () => {
    // Companion on disk but no matching registry package → must not surface.
    writeCompanion('ghostpkg', 'ghostpkg', 'orphaned companion');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ includeSkillSearchHint: true });
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
