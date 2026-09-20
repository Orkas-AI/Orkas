import { estimateBudgetTokens } from '../../../src/main/util/token-estimate';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_ROSTER_MAX_TOKENS } from '../../../src/main/util/skill-description-policy';

// skill-registry.ts wraps core-agent's SkillLoader. To test allowlist
// filtering without pulling in the real core-agent import, we write fake
// SKILL.md files under the new skills layout and let the real SkillLoader
// scan them — the loader is pure FS + frontmatter parsing, no network/LLM.
//
// Post-refactor layout:
//   platform/builtin skills → `<WS_ROOT>/<uid>/local/marketplace/skills/<id>/SKILL.md`
//   custom skills           → `<WS_ROOT>/<uid>/cloud/skills/<id>/SKILL.md`
// The loader scans marketplace first so same-id platform/builtin overrides custom.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

function builtinDirFor(uid: string): string {
  return path.join(tmpDir, uid, 'local', 'marketplace', 'skills');
}
function builtinDir(): string {
  return builtinDirFor(TEST_UID);
}
function customDirFor(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'skills');
}
function customDir(): string {
  return customDirFor(TEST_UID);
}
function systemDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'system', 'skills');
}
function systemDirFor(uid: string): string {
  return path.join(tmpDir, uid, 'local', 'system', 'skills');
}
function agentPrivateDir(agentId: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'agents', agentId, 'private_skills');
}
function agentEvolvedDir(agentId: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'agents', agentId, 'skills');
}

function writeSkill(root: string, id: string, name: string, description: string, installMeta?: Record<string, unknown>) {
  const skillDir = path.join(root, id);
  fs.mkdirSync(skillDir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\n---\nbody`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), md);
  if (installMeta) {
    fs.writeFileSync(path.join(skillDir, '_install.json'), JSON.stringify(installMeta));
  }
}

function writeLocalizedSkill(
  root: string,
  id: string,
  name: string,
  descriptionZh: string,
  descriptionEn: string,
) {
  const skillDir = path.join(root, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description_zh: ${JSON.stringify(descriptionZh)}`,
      `description_en: ${JSON.stringify(descriptionEn)}`,
      '---',
      'body',
    ].join('\n'),
  );
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skillreg-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  vi.doUnmock('#core-agent');
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRegistry() {
  return import('../../../src/main/model/core-agent/skill-registry');
}

describe('Agent authoring Skill candidates', () => {
  it('advertises all packaged shared and System descriptions once without loading bodies', async () => {
    const packaged = path.resolve(__dirname, '../../../resources/builtin');
    const { SkillLoader } = await import('../../../src/core-agent/src/skills/loader');
    const specs = [];
    for (const [tier, destination] of [['system', systemDir()], ['marketplace', builtinDir()]]) {
      const source = path.join(packaged, tier, 'skills');
      const loaded = new SkillLoader({ dirs: [source] }).list();
      specs.push(...loaded);
      for (const spec of loaded) {
        const dir = path.join(destination, spec.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(spec.dir, 'SKILL.md'), path.join(dir, 'SKILL.md'));
        fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({ seed_source: 'builtin' }));
      }
    }
    expect(specs.length).toBeGreaterThan(0);
    const registry = await loadRegistry();
    const bindings = new Map<string, import('../../../src/main/model/core-agent/skill-registry').SkillRuntimeBinding>();
    const system = await registry.getSystemSkillsPromptBlock(TEST_UID, bindings);
    const shared = await registry.getSystemPromptBlock({ runtimeBindings: bindings, includeSkillSearchHint: true });
    const block = `${system}\n\n${shared}`;
    expect(new Set([...bindings.values()].map(binding => binding.entry)).size).toBe(specs.length);
    for (const spec of specs) {
      expect(block.split(spec.description_en)).toHaveLength(2);
      expect(block).not.toContain(spec.description_zh);
      expect(block).toContain(`**${spec.name}**`);
      const body = fs.readFileSync(spec.skillFile, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      expect(body).not.toBe('');
      expect(block).not.toContain(body);
    }
    console.info('Packaged Skill roster characters', JSON.stringify({ system: system.length, shared: shared.length, combined: block.length }));
  });

  it('uses enabled target bindings and provenance rather than copying System names or aliases', async () => {
    writeSkill(systemDir(), 'package-installer', 'package-installer', 'System installation protocol');
    writeSkill(customDir(), 'shared-copy', 'package-installer', 'An independent shared helper');
    writeSkill(customDir(), 'disabled-helper', 'disabled-helper', 'Disabled helper');
    writeSkill(customDir(), 'foreign-helper', 'foreign-helper', 'Foreign helper');
    fs.writeFileSync(path.join(customDir(), 'foreign-helper', 'SKILL.md'),
      '---\nname: foreign-helper\ndescription: Foreign helper\nownerAgent: another-agent\n---\nbody');
    writeSkill(agentPrivateDir('target'), 'own-helper', 'own-helper', 'Owned helper');
    const registry = await loadRegistry();
    const bindings = new Map<string, import('../../../src/main/model/core-agent/skill-registry').SkillRuntimeBinding>();
    await registry.getSystemSkillsPromptBlock(TEST_UID, bindings);
    await registry.getSystemPromptBlock({ agentId: 'target',
      allowlist: ['shared-copy', 'disabled-helper', 'foreign-helper'],
      disabledIds: ['disabled-helper'], runtimeBindings: bindings });
    for (const source of ['external', 'global', 'unknown']) {
      registry.bindRuntimeSkillTarget({ id: `${source}-helper`, name: `${source}-helper`,
        source, root: path.join(tmpDir, source), entry: path.join(tmpDir, source, 'SKILL.md') }, bindings);
    }
    const before = bindings.size;
    const directory = registry.getAgentSkillDependenciesPromptBlock(bindings);
    expect(directory).toContain('**package-installer** (read ref: @skill/shared-copy)');
    expect(directory).not.toContain('@skill/package-installer');
    expect(directory).toContain('own-helper');
    expect(directory).not.toContain('disabled-helper');
    expect(directory).not.toContain('foreign-helper');
    for (const source of ['external', 'global', 'unknown']) expect(directory).not.toContain(`${source}-helper`);
    expect(directory.match(/\*\*package-installer\*\*/g)).toHaveLength(1);
    expect(bindings.size).toBe(before);
    expect(bindings.get('package-installer')!.source).toBe('system');
  });

  it('keeps a compact bounded candidate directory and explicitly represents no dependencies', async () => {
    const registry = await loadRegistry();
    expect(registry.getAgentSkillDependenciesPromptBlock(new Map())).toContain('(none)');
    for (let i = 0; i < 300; i++) {
      writeSkill(customDir(), `helper-${i}`, `helper-${i}`, 'Shared helper for authored workflows.');
    }
    const bindings = new Map<string, import('../../../src/main/model/core-agent/skill-registry').SkillRuntimeBinding>();
    await registry.getSystemPromptBlock({ runtimeBindings: bindings });
    const directory = registry.getAgentSkillDependenciesPromptBlock(bindings);
    expect(directory).toContain('helper-0');
    expect(estimateBudgetTokens(directory)).toBeLessThanOrEqual(SKILL_ROSTER_MAX_TOKENS);
    expect(directory).not.toContain(tmpDir);
  });
});

describe('CLI private Skill ownership', () => {
  it('gives SDK guidance System precedence without exposing other System protocols or other accounts', async () => {
    writeSkill(systemDir(), 'web-app-sdk', 'web-app-sdk', 'Build Orkas apps');
    writeSkill(systemDir(), 'skill-creator', 'skill-creator', 'Mutate Skills');
    writeSkill(systemDir(), 'orkas-guide', 'orkas-guide', 'Product guide');
    writeSkill(customDir(), 'web-app-sdk', 'forged-sdk', 'Shadow by id');
    writeSkill(customDir(), 'shadow', 'web-app-sdk', 'Shadow by name');
    const registry = await loadRegistry();
    const rows = await registry.listSkillsForBridge(TEST_UID, 'agent-a');
    expect(rows.map(s => ({id:s.id,source:s.source}))).toEqual([{id:'web-app-sdk',source:'system'}]);
    expect(rows[0].skillFile).toBe(path.join(systemDir(), 'web-app-sdk', 'SKILL.md'));
    expect(await registry.listSkillsForBridge('other-account', 'agent-a')).toEqual([]);
    expect(await registry.getSystemPromptBlock()).not.toContain('Build Orkas apps');
  });
  it('includes only the bound Agent private, installed and learned Skills without changing public discovery', async () => {
    writeSkill(customDir(), 'shared', 'shared', 'shared helper');
    writeSkill(agentPrivateDir('agent-a'), 'private-a', 'private-a', 'private helper');
    writeSkill(agentEvolvedDir('agent-a'), 'learned-a', 'learned-a', 'learned helper');
    writeSkill(path.join(tmpDir, TEST_UID, 'local', 'marketplace', 'agents', 'agent-a', 'skills'), 'installed-a', 'installed-a', 'installed helper');
    writeSkill(agentPrivateDir('agent-b'), 'private-b', 'private-b', 'foreign helper');
    writeSkill(agentPrivateDir('agent-a'), 'forged', 'forged', 'wrong owner');
    const forgedFile = path.join(agentPrivateDir('agent-a'), 'forged', 'SKILL.md');
    fs.writeFileSync(forgedFile, '---\nname: forged\ndescription: wrong owner\nownerAgent: agent-b\n---\nFOREIGN');
    fs.symlinkSync(path.join(agentPrivateDir('agent-b'), 'private-b'), path.join(agentPrivateDir('agent-a'), 'borrowed-package'), 'dir');
    fs.mkdirSync(path.join(agentPrivateDir('agent-a'), 'borrowed-entry'));
    fs.symlinkSync(path.join(agentPrivateDir('agent-b'), 'private-b', 'SKILL.md'), path.join(agentPrivateDir('agent-a'), 'borrowed-entry', 'SKILL.md'));
    const registry = await loadRegistry();
    const mine = await registry.listSkillsForBridge(TEST_UID, 'agent-a');
    expect(mine.map((s) => s.id).sort()).toEqual(['installed-a', 'learned-a', 'private-a', 'shared']);
    expect(mine.filter((s) => s.id !== 'shared').every((s) => s.source === 'agent')).toBe(true);
    expect((await registry.listSkillsForBridge(TEST_UID)).map((s) => s.id)).toEqual(['shared']);
    expect((await registry.listSkillsForBridge(TEST_UID, 'agent-b')).map((s) => s.id).sort()).toEqual(['private-b', 'shared']);
    expect((await registry.listSkillsForBridge('other-account', 'agent-a')).map((s) => s.id)).toEqual([]);
    fs.mkdirSync(path.dirname(agentPrivateDir('agent-c')), { recursive: true });
    fs.symlinkSync(agentPrivateDir('agent-b'), agentPrivateDir('agent-c'), 'dir');
    expect((await registry.listSkillsForBridge(TEST_UID, 'agent-c')).map((s) => s.id)).toEqual(['shared']);
  });
});

describe('skill-registry › getSystemPromptBlock(allowlist)', () => {
  it('returns full listing when allowlist is undefined (legacy behavior)', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(customDir(), 'summarize', 'Summarize', 'S');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('translate');
    expect(text).toContain('summarize');
  });

  it('rebuilds the trusted Skill roster and logical bindings when the active account changes', async () => {
    writeSkill(customDirFor('u1'), 'account-a-only', 'Account A Only', 'visible only to account A');
    writeSkill(customDirFor('u2'), 'account-b-only', 'Account B Only', 'visible only to account B');
    const registry = await loadRegistry();

    const accountABindings = new Map();
    const accountAText = await registry.getSystemPromptBlock({ runtimeBindings: accountABindings });
    expect(accountAText).toContain('Account A Only');
    expect(accountAText).not.toContain('Account B Only');

    const users = await import('../../../src/main/features/users');
    users.activateUser('u2');
    const accountBBindings = new Map();
    const accountBText = await registry.getSystemPromptBlock({ runtimeBindings: accountBBindings });
    expect(accountBText).toContain('Account B Only');
    expect(accountBText).not.toContain('Account A Only');
    expect(accountBBindings.get('account-b-only')).toMatchObject({
      root: path.join(path.resolve(customDirFor('u2')), 'account-b-only'),
    });
    expect(accountBBindings.has('account-a-only')).toBe(false);

    const explicitAccountASpecs = await registry.listSkillSpecsForAgentMetadata('u1');
    expect(explicitAccountASpecs.map((spec) => spec.id)).toContain('account-a-only');
    expect(explicitAccountASpecs.map((spec) => spec.id)).not.toContain('account-b-only');
  });

  it('renders the platform Skill when trusted roots contain the same id', async () => {
    writeSkill(builtinDir(), 'shared-skill', 'Platform Shared', 'platform body marker');
    writeSkill(customDir(), 'shared-skill', 'Custom Shared', 'custom body marker');
    const runtimeBindings = new Map();
    const { getSystemPromptBlock } = await loadRegistry();

    const text = await getSystemPromptBlock({ runtimeBindings });

    expect(text).toContain('**Platform Shared**');
    expect(text).toContain('platform body marker');
    expect(text).not.toContain('Custom Shared');
    expect(text).not.toContain('custom body marker');
    expect(runtimeBindings.get('shared-skill')).toMatchObject({
      source: 'platform',
      root: path.join(path.resolve(builtinDir()), 'shared-skill'),
    });
  });

  it('renders only allowlisted skills when allowlist is provided', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(builtinDir(), 'summarize', 'Summarize', 'S');
    writeSkill(builtinDir(), 'search', 'Search', 'X');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['translate', 'search'] });
    expect(text).toContain('translate');
    expect(text).toContain('search');
    expect(text).not.toContain('summarize');
  });

  it('matches allowlist entries by display name when marketplace id differs', async () => {
    writeSkill(builtinDir(), '6bb95f967501', 'github', 'GitHub skill');
    writeSkill(builtinDir(), 'daa4378ab55a', 'find-skill', 'Find skill');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['github', 'find-skill'] });
    expect(text).toContain('**github** (Source: platform; internal read id: 6bb95f967501)');
    expect(text).toContain('**find-skill** (Source: platform; internal read id: daa4378ab55a)');
    expect(text).not.toContain('(id: 6bb95f967501)');
  });

  it('builds run-scoped logical refs from the already-filtered Skill list', async () => {
    writeSkill(builtinDir(), '6bb95f967501', 'github', 'GitHub skill');
    writeSkill(builtinDir(), 'daa4378ab55a', 'find-skill', 'Find skill');
    writeSkill(builtinDir(), 'not-selected', 'hidden-skill', 'Hidden skill');
    const runtimeBindings = new Map();
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      allowlist: ['github', 'find-skill'],
      runtimeBindings,
    });

    expect(text).toContain('read_files({"paths":[{"path":"@skill/<read-ref>"}]})');
    expect(text).toContain('read ref: @skill/github');
    expect(text).toContain('read ref: @skill/find-skill');
    expect(text).not.toContain(path.resolve(builtinDir()));
    expect(text).not.toContain('internal read id');
    expect(runtimeBindings.get('github')).toMatchObject({
      id: '6bb95f967501',
      name: 'github',
      root: path.join(path.resolve(builtinDir()), '6bb95f967501'),
    });
    expect(runtimeBindings.get('6bb95f967501')).toBe(runtimeBindings.get('github'));
    expect(runtimeBindings.has('hidden-skill')).toBe(false);
    expect(runtimeBindings.has('not-selected')).toBe(false);
  });

  it('falls back to unique ids for same-name runtime refs without overwriting the first binding', async () => {
    writeSkill(builtinDir(), '111111111111', 'agent-static-review', 'first marketplace desc');
    writeSkill(builtinDir(), '222222222222', 'agent-static-review', 'second marketplace desc');
    const runtimeBindings = new Map();
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ runtimeBindings });

    expect(text).toContain('read ref: @skill/agent-static-review');
    expect(text).toContain('read ref: @skill/222222222222');
    expect(runtimeBindings.get('agent-static-review')?.id).toBe('111111111111');
    expect(runtimeBindings.get('222222222222')?.id).toBe('222222222222');
  });

  it('returns empty string when allowlist is [] (agent opting out of all skills)', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: [] });
    expect(text).toBe('');
  });

  it('still renders the acting agent private skills under an empty allowlist', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(agentPrivateDir('agent-a'), 'private-helper', 'private-helper', 'private help');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ agentId: 'agent-a', allowlist: [] });
    expect(text).toContain('private-helper');
    expect(text).not.toContain('translate');
  });

  it('treats skill_list as Agent defaults: own private stays resident and every undeclared shared Skill stays lazy', async () => {
    writeSkill(builtinDir(), 'builtin-core', 'Builtin Core', 'always resident builtin', { seed_source: 'builtin' });
    writeSkill(builtinDir(), 'installed-extra', 'Installed Extra', 'lazy installed capability');
    writeSkill(customDir(), 'custom-extra', 'Custom Extra', 'lazy custom capability');
    writeSkill(agentPrivateDir('agent-a'), 'private-core', 'Private Core', 'owner-only private protocol');
    const { getSystemPromptBlock } = await loadRegistry();

    const missing = await getSystemPromptBlock({ agentId: 'agent-a', includeSkillSearchHint: true });
    const empty = await getSystemPromptBlock({ agentId: 'agent-a', allowlist: [], includeSkillSearchHint: true });
    for (const text of [missing, empty]) {
      expect(text).not.toContain('Builtin Core');
      expect(text).toContain('Private Core');
      expect(text).toContain('owner-only private protocol');
      expect(text).not.toContain('Installed Extra');
      expect(text).not.toContain('Custom Extra');
      expect(text).toContain('skill_search');
    }

    const configured = await getSystemPromptBlock({
      agentId: 'agent-a',
      allowlist: ['builtin-core', 'custom-extra'],
      includeSkillSearchHint: true,
    });
    expect(configured).toContain('Builtin Core');
    expect(configured).toContain('Custom Extra');
    expect(configured).toContain('Private Core');
    expect(configured).not.toContain('Installed Extra');
  });

  it('does not impose a Skill-count limit while the routing index fits', async () => {
    for (let i = 0; i < 60; i += 1) {
      const id = `small-${String(i).padStart(2, '0')}`;
      writeSkill(customDir(), id, id, 'd');
    }
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ runtimeBindings: new Map() });

    expect(estimateBudgetTokens(text)).toBeLessThanOrEqual(SKILL_ROSTER_MAX_TOKENS);
    expect((text.match(/^- \*\*/gm) || [])).toHaveLength(60);
    expect(text).toContain('small-59');
  });

  it('compacts an overflowing roster by source while preserving mandatory and explicit descriptions', async () => {
    const detail = (marker: string) => `${marker} ${'routing detail '.repeat(35)}`;
    writeSkill(builtinDir(), 'builtin-core', 'Builtin Core', detail('BUILTIN-FULL'), { seed_source: 'builtin' });
    for (let i = 0; i < 25; i += 1) {
      writeSkill(builtinDir(), `installed-${i}`, `Installed ${i}`, detail(`INSTALLED-DETAIL-${i}`));
      writeSkill(customDir(), `custom-${i}`, `Custom ${i}`, detail(`CUSTOM-DETAIL-${i}`));
    }
    const runtimeBindings = new Map();
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      runtimeBindings,
      includeSkillSearchHint: true,
      forceOpenSkillRefs: [{ id: 'custom-24', source: 'custom' }],
    });

    expect(estimateBudgetTokens(text)).toBeLessThanOrEqual(SKILL_ROSTER_MAX_TOKENS);
    expect(text).toContain('BUILTIN-FULL');
    expect(text).toContain('CUSTOM-DETAIL-24');
    // Gradual compaction: the top-ranked searchable rows (platform before
    // custom, then registry order) keep their descriptions while the budget
    // lasts; only the tail degrades to name-only rows.
    expect(text).toContain('Installed 0');
    expect(text).toContain('INSTALLED-DETAIL-0');
    const detailedInstalled = [...text.matchAll(/INSTALLED-DETAIL-(\d+)/g)].map((m) => m[1]);
    expect(detailedInstalled.length).toBeGreaterThan(0);
    expect(detailedInstalled.length).toBeLessThan(25);
    // Registry order is the id order, so the described rows form its prefix.
    const registryOrder = Array.from({ length: 25 }, (_, i) => String(i)).sort();
    expect(detailedInstalled).toEqual(registryOrder.slice(0, detailedInstalled.length));
    expect(text).toContain('Installed 24');
    expect(text).toContain('Custom 0');
    expect(text).not.toContain('CUSTOM-DETAIL-0');
  });

  it('degrades nothing while the described roster fits and everything searchable when only names fit', async () => {
    const detail = (marker: string) => `${marker} ${'routing detail '.repeat(30)}`;
    writeSkill(builtinDir(), 'builtin-core', 'Builtin Core', detail('BUILTIN-FULL'), { seed_source: 'builtin' });
    for (let i = 0; i < 4; i += 1) writeSkill(customDir(), `custom-${i}`, `Custom ${i}`, detail(`CUSTOM-DETAIL-${i}`));
    const { getSystemPromptBlock } = await loadRegistry();
    const fits = await getSystemPromptBlock({ runtimeBindings: new Map(), includeSkillSearchHint: true });
    for (let i = 0; i < 4; i += 1) expect(fits).toContain(`CUSTOM-DETAIL-${i}`);

    for (let i = 4; i < 40; i += 1) writeSkill(customDir(), `custom-${i}`, `Custom ${i}`, detail(`CUSTOM-DETAIL-${i}`));
    const { getSystemPromptBlock: reloaded } = await loadRegistry();
    const crowded = await reloaded({ runtimeBindings: new Map(), includeSkillSearchHint: true });
    expect(estimateBudgetTokens(crowded)).toBeLessThanOrEqual(SKILL_ROSTER_MAX_TOKENS);
    expect(crowded).toContain('BUILTIN-FULL');
    // Every name still fits, so names are kept first; the first-ranked rows
    // keep their detail and only the tail degrades to name-only rows.
    for (let i = 0; i < 40; i += 1) expect(crowded).toContain(`Custom ${i}`);
    expect(crowded).toContain('CUSTOM-DETAIL-0');
    expect(crowded).not.toContain('CUSTOM-DETAIL-39');
  });

  it('retains platform-installed name rows before custom rows when name-only entries must be omitted', async () => {
    const detail = `${'routing detail '.repeat(34)}END`;
    const platformIds: string[] = [];
    const customIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const suffix = String(i).padStart(3, '0');
      const id = `platform-priority-${suffix}`;
      platformIds.push(id);
      writeSkill(builtinDir(), id, `Platform Priority ${suffix} ${'p'.repeat(30)}`, detail);
    }
    for (let i = 0; i < 140; i += 1) {
      const suffix = String(i).padStart(3, '0');
      const id = `custom-priority-${suffix}`;
      customIds.push(id);
      writeSkill(customDir(), id, `Custom Priority ${suffix} ${'c'.repeat(32)}`, detail);
    }

    const runtimeBindings = new Map<string, any>();
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      runtimeBindings,
      includeSkillSearchHint: true,
    });
    const boundIds = new Set([...runtimeBindings.values()].map((binding) => binding.id));

    expect(estimateBudgetTokens(text)).toBeLessThanOrEqual(SKILL_ROSTER_MAX_TOKENS);
    expect(platformIds.every((id) => boundIds.has(id))).toBe(true);
    expect(customIds.some((id) => boundIds.has(id))).toBe(true);
    expect(customIds.some((id) => !boundIds.has(id))).toBe(true);
    expect(text).not.toContain('routing detail');
  });

  it('keeps Agent-private routing detail resident while compacting searchable shared rows', async () => {
    const detail = (marker: string) => `${marker} ${'routing detail '.repeat(34)}`;
    writeSkill(agentPrivateDir('agent-a'), 'private-required', 'Private Required', detail('PRIVATE-FULL'));
    for (let i = 0; i < 50; i += 1) {
      writeSkill(customDir(), `shared-${i}`, `Shared ${i}`, detail(`SHARED-${i}`));
    }

    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      agentId: 'agent-a',
      allowlist: Array.from({ length: 50 }, (_, i) => `shared-${i}`),
      includeSkillSearchHint: true,
      runtimeBindings: new Map(),
    });

    expect(estimateBudgetTokens(text)).toBeLessThanOrEqual(SKILL_ROSTER_MAX_TOKENS);
    expect(text).toContain('PRIVATE-FULL');
    expect(text).toContain('Shared 0');
    // Gradual compaction keeps the first-ranked shared descriptions and
    // degrades the tail; the private detail is never traded away.
    expect(text).toContain('SHARED-0');
    expect(text).not.toContain('SHARED-49');
    const described = [...text.matchAll(/SHARED-(\d+)/g)].length;
    expect(described).toBeGreaterThan(0);
    expect(described).toBeLessThan(50);
  });

  it('omits only searchable tail rows when even the name-only roster overflows', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 180; i += 1) {
      const id = `searchable-${String(i).padStart(3, '0')}`;
      ids.push(id);
      writeSkill(customDir(), id, `${id}-${'x'.repeat(55)}`, `capability marker ${id}`);
    }
    const runtimeBindings = new Map<string, any>();
    const advertised: string[] = [];
    const displayNames = new Map<string, string>();
    const { bindRuntimeSkillTarget, getSystemPromptBlock, searchAvailableSkills } = await loadRegistry();
    const text = await getSystemPromptBlock({
      runtimeBindings,
      includeSkillSearchHint: true,
      displayNameById: displayNames,
      onSkillAdvertised: (id) => advertised.push(id),
    });
    const boundIds = new Set([...runtimeBindings.values()].map((binding) => binding.id));
    const omitted = ids.find((id) => !boundIds.has(id));

    expect(estimateBudgetTokens(text)).toBeLessThanOrEqual(SKILL_ROSTER_MAX_TOKENS);
    expect(omitted).toBeTruthy();
    expect(text).not.toContain(omitted!);
    expect(advertised).not.toContain(omitted!);
    expect(displayNames.has(omitted!)).toBe(false);
    const residentRefs = new Set(
      [...runtimeBindings.values()].flatMap((binding) => [binding.id, binding.name]),
    );
    const found = await searchAvailableSkills(TEST_UID, omitted!, 5, undefined, 0, residentRefs);
    expect(found.rows[0]).toEqual(expect.objectContaining({ id: omitted, source: 'custom' }));
    const row = found.rows[0];
    const ref = bindRuntimeSkillTarget({
      id: row.id,
      name: row.name,
      root: path.dirname(row.read_path),
      entry: row.read_path,
      source: row.source,
    }, runtimeBindings);
    expect(runtimeBindings.get(ref)).toMatchObject({
      id: omitted,
      root: path.join(path.resolve(customDir()), omitted!),
      entry: path.join(path.resolve(customDir()), omitted!, 'SKILL.md'),
    });
  });

  it('does not render self-evolved skills — core-agent evolution injects those, not this block', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    writeSkill(agentEvolvedDir('agent-a'), 'evolved-helper', 'evolved-helper', 'evolved help');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ agentId: 'agent-a', allowlist: [] });
    // Self-evolved skills (cloud/agents/<id>/skills) are surfaced by core-agent's
    // evolution SkillStore.buildIndex(); rendering them here too would double-inject.
    expect(text).not.toContain('evolved-helper');
    expect(text).not.toContain('translate');
  });

  it('preserves allowlist order when mixing agent-scoped and trusted skills', async () => {
    writeSkill(customDir(), 'selected-helper', 'selected-helper', 'selected help');
    writeSkill(agentPrivateDir('agent-a'), 'default-helper', 'default-helper', 'default help');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      agentId: 'agent-a',
      allowlist: ['default-helper', 'selected-helper'],
      forceOpenSkillRefs: ['selected-helper'],
    });
    expect(text.indexOf('default-helper')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('selected-helper')).toBeGreaterThan(text.indexOf('default-helper'));
  });

  it('silently drops unknown ids in the allowlist', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['translate', 'nonexistent'] });
    expect(text).toContain('translate');
    expect(text).not.toContain('nonexistent');
  });

  it('returns empty string when allowlist provided but no matching skills exist', async () => {
    writeSkill(builtinDir(), 'translate', 'Translate', 'T');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['nonexistent'] });
    expect(text).toBe('');
  });

  // Regression: per-uid migration (CLAUDE.md §4) made both skill roots end
  // in `/skills`, so deriving the `Source` tag from basename collapses to
  // `skills` for every entry. `chat_commander.md` / `chat_agent_in_group.md`
  // tell the LLM to pick a root by `Source: builtin|platform|custom` — a degenerate label
  // sends it guessing and half the SKILL.md reads ENOENT on first try.
  it('labels `Source` as platform vs custom by root path, not basename', async () => {
    writeSkill(builtinDir(), 'shipped', 'Shipped', 'desc-platform');
    writeSkill(customDir(), 'mine', 'Mine', 'desc-custom');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('Source: platform');
    expect(text).toContain('Source: custom');
    expect(text).not.toContain('Source: skills');
  });

  it('labels packaged seed skills as builtin from install metadata', async () => {
    writeSkill(builtinDir(), 'seeded', 'Seeded', 'desc-builtin', { seed_source: 'builtin' });
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('**Seeded** (Source: builtin; internal read id: seeded) — desc-builtin');
  });

  // The block embeds a Read-pattern header with resolved ROOT values for
  // both sources + an anti-prior warning. Without these, the LLM falls back
  // on training-prior layouts (e.g. `/data/custom/skills/<id>/`) and trips
  // E_PATH_OUT_OF_SCOPE on `read_file`. See bus.ts substitution map cleanup
  // — `$builtin_skills_dir / $custom_skills_dir` no longer flow through the
  // prompt template, so this header IS the only place the LLM learns the
  // real root paths.
  it('block header carries Read pattern + resolved ROOT values', async () => {
    writeSkill(builtinDir(), 'shipped', 'Shipped', 'desc-b');
    writeSkill(customDir(), 'mine', 'Mine', 'desc-c');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('`read_files({"paths":[{"path":"<ROOT>/<id>/SKILL.md"}]})`');
    expect(text).toContain(`- custom:  ${path.resolve(customDir())}`);
    expect(text).toContain(`- platform: ${path.resolve(builtinDir())}`);
    expect(text).toContain(`- builtin: ${path.resolve(builtinDir())}`);
    expect(text).toContain('Use these ROOT values verbatim');
    expect(text).toContain('These entries are skills, not tool names');
    expect(text).toContain('never call the display name or id as a tool');
    expect(text).toContain('Never mention skill ids');
  });

  it('block omits ROOT header when no skills are present (renderSkillLines short-circuits empty)', async () => {
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toBe('');
  });

  it('preserves routing intent and boundaries in prompt descriptions', async () => {
    writeSkill(customDir(), 'zh-long', 'ZhLong', '抓取网页并提取结构化信息；适合网页调研和数据整理；触发词：抓取、网页');
    writeSkill(customDir(), 'zh-sentence', 'ZhSentence', '分析资料并输出结论。适合深度研究。');
    writeSkill(customDir(), 'en-long', 'EnLong', 'Analyze API logs. Suitable for debugging production incidents. Triggers: logs, traces.');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('**ZhLong** (Source: custom; internal read id: zh-long) — 抓取网页并提取结构化信息；适合网页调研和数据整理；触发词：抓取、网页');
    expect(text).toContain('**ZhSentence** (Source: custom; internal read id: zh-sentence) — 分析资料并输出结论。适合深度研究。');
    expect(text).toContain('**EnLong** (Source: custom; internal read id: en-long) — Analyze API logs. Suitable for debugging production incidents. Triggers: logs, traces.');
  });

  it('renders bilingual regular Skill routing descriptions in English', async () => {
    writeLocalizedSkill(
      customDir(),
      'bilingual-route',
      'BilingualRoute',
      '中文内部路由说明',
      'English internal routing description',
    );
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();

    expect(text).toContain('**BilingualRoute** (Source: custom; internal read id: bilingual-route) — English internal routing description');
    expect(text).not.toContain('中文内部路由说明');
  });

  it('dedupes same display-name skills with platform shadowing custom', async () => {
    writeSkill(builtinDir(), 'platform-reviewer', 'agent-static-review', 'platform desc');
    writeSkill(customDir(), 'custom-reviewer', 'agent-static-review', 'custom desc');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock();
    expect(text).toContain('**agent-static-review** (Source: platform; internal read id: platform-reviewer) — platform desc');
    expect(text).not.toContain('custom-reviewer');
    expect(text).not.toContain('custom desc');
  });

  it('keeps same display-name marketplace skills with different internal ids', async () => {
    writeSkill(builtinDir(), '111111111111', 'agent-static-review', 'first marketplace desc');
    writeSkill(builtinDir(), '222222222222', 'agent-static-review', 'second marketplace desc');
    const advertised: Array<{ id: string; system: string }> = [];
    const displayNameById = new Map<string, string>();
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({
      displayNameById,
      onSkillAdvertised(id, system) {
        advertised.push({ id, system });
      },
    });

    expect(text).toContain('**agent-static-review** (Source: platform; internal read id: 111111111111) — first marketplace desc');
    expect(text).toContain('**agent-static-review** (Source: platform; internal read id: 222222222222) — second marketplace desc');
    expect(advertised).toEqual([
      { id: '111111111111', system: 'A.platform' },
      { id: '222222222222', system: 'A.platform' },
    ]);
    expect(displayNameById.get('111111111111')).toBe('agent-static-review');
    expect(displayNameById.get('222222222222')).toBe('agent-static-review');
  });

  it('keeps explicitly allowlisted same-name marketplace skill ids', async () => {
    writeSkill(builtinDir(), '111111111111', 'agent-static-review', 'first marketplace desc');
    writeSkill(builtinDir(), '222222222222', 'agent-static-review', 'second marketplace desc');
    writeSkill(builtinDir(), '333333333333', 'other-skill', 'other desc');
    const { getSystemPromptBlock } = await loadRegistry();
    const text = await getSystemPromptBlock({ allowlist: ['111111111111', '222222222222'] });

    expect(text).toContain('internal read id: 111111111111');
    expect(text).toContain('internal read id: 222222222222');
    expect(text).not.toContain('333333333333');
    expect(text).not.toContain('other desc');
  });

  it('reuses agent-private SkillLoader instances while still seeing root mtime changes', async () => {
    let constructed = 0;
    vi.doMock('#core-agent', async (importOriginal) => {
      const actual = await importOriginal<any>();
      class CountingSkillLoader extends actual.SkillLoader {
        constructor(opts: any) {
          super(opts);
          constructed++;
        }
      }
      return { ...actual, SkillLoader: CountingSkillLoader };
    });

    writeSkill(agentPrivateDir('video-studio'), 'private-one', 'private-one', 'first private skill');
    const { getSystemPromptBlock } = await loadRegistry();
    const firstBindings = new Map();
    const first = await getSystemPromptBlock({
      agentId: 'video-studio',
      runtimeBindings: firstBindings,
    });

    expect(first).toContain('private-one');
    expect(firstBindings.get('private-one')?.id).toBe('private-one');
    expect(constructed).toBe(2); // trusted loader + one agent-private root loader

    writeSkill(agentPrivateDir('video-studio'), 'private-two', 'private-two', 'second private skill');
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(agentPrivateDir('video-studio'), later, later);
    const secondBindings = new Map();
    const second = await getSystemPromptBlock({
      agentId: 'video-studio',
      runtimeBindings: secondBindings,
    });

    expect(second).toContain('private-one');
    expect(second).toContain('private-two');
    expect(secondBindings.has('private-two')).toBe(true);
    expect(constructed).toBe(2);
  });

  it('lists agent-owned private and self-evolved skill ids', async () => {
    writeSkill(agentPrivateDir('video-studio'), 'private-one', 'private-one', 'first private skill');
    writeSkill(agentEvolvedDir('video-studio'), 'evolved-one', 'evolved-one', 'first evolved skill');
    const { listAgentOwnedSkillIds } = await loadRegistry();
    await expect(listAgentOwnedSkillIds(TEST_UID, 'video-studio')).resolves.toEqual([
      'private-one',
      'evolved-one',
    ]);
  });
});

describe('skill-registry › getSystemSkillsPromptBlock', () => {
  it('renders bilingual System Skill routing descriptions in English', async () => {
    writeLocalizedSkill(
      systemDir(),
      'bilingual-system-route',
      'bilingual-system-route',
      '中文系统协议说明',
      'English system protocol description',
    );
    const { getSystemSkillsPromptBlock } = await loadRegistry();
    const text = await getSystemSkillsPromptBlock();

    expect(text).toContain('**bilingual-system-route** — English system protocol description');
    expect(text).not.toContain('中文系统协议说明');
  });

  it('renders system skills in a separate block with SYSTEM_SKILLS_ROOT', async () => {
    writeSkill(systemDir(), 'agent-creator', 'agent-creator', 'Create agents');
    writeSkill(systemDir(), 'fixture-automation-guide', 'fixture-automation-guide', 'Create automations');
    writeSkill(
      systemDir(),
      'orkas-guide',
      'orkas-guide',
      "Answer user questions about how to use current Orkas application features, navigation, settings, availability, and recovery, including a distinct product-usage question within a mixed request. Supply user-facing product facts only. Do not guide Commander execution, own creation or other work requests, or load merely because work happens inside Orkas.",
    );
    writeSkill(systemDir(), 'package-installer', 'package-installer', 'Install packages');
    writeSkill(
      systemDir(),
      'fixture-backlog-guide',
      'fixture-backlog-guide',
      'Manage or execute the structured project backlog',
    );
    writeSkill(systemDir(), 'skill-creator', 'skill-creator', 'Create skills');
    const { getSystemSkillsPromptBlock, getSystemPromptBlock } = await loadRegistry();

    const systemText = await getSystemSkillsPromptBlock();
    expect(systemText).toContain('## System skills');
    expect(systemText).toContain('SYSTEM_SKILLS_ROOT');
    expect(systemText).toContain(path.resolve(systemDir()));
    expect(systemText).toContain('Treat each description as an activation contract.');
    expect(systemText).toContain('intended outcome and context, not keyword overlap.');
    expect(systemText).toContain('Before answering or calling another tool');
    expect(systemText).toContain('read the smallest complete set whose use conditions apply');
    expect(systemText).toContain('never load nonmatches.');
    expect(systemText).toContain('Read all matches together in one call (one path entry per match):');
    const examples = [...systemText.matchAll(/`read_files\((\{[^\n]+\})\)`/g)];
    expect(examples).toHaveLength(1);
    expect(JSON.parse(examples[0][1])).toEqual({
      paths: [{ path: '<SYSTEM_SKILLS_ROOT>/<id>/SKILL.md' }],
    });
    expect(systemText).toContain('Load only system SKILL.md files in that call');
    expect(systemText).toContain('read attachments and other task sources afterward.');
    expect(systemText).toContain('**agent-creator**');
    expect(systemText).toContain('**fixture-automation-guide**');
    expect(systemText).toContain('**orkas-guide**');
    expect(systemText).toContain('questions about how to use current Orkas application features');
    expect(systemText).toContain('distinct product-usage question within a mixed request');
    expect(systemText).toContain('Do not guide Commander execution');
    expect(systemText).toContain('**package-installer**');
    expect(systemText).toContain('**fixture-backlog-guide**');
    expect(systemText).toContain('structured project backlog');
    expect(systemText).toContain('**skill-creator**');

    const regularText = await getSystemPromptBlock();
    expect(regularText).not.toContain('agent-creator');
    expect(regularText).not.toContain('fixture-automation-guide');
    expect(regularText).not.toContain('orkas-guide');
    expect(regularText).not.toContain('package-installer');
    expect(regularText).not.toContain('fixture-backlog-guide');
    expect(regularText).not.toContain('skill-creator');
  });

  it('uses an explicit user id for SYSTEM_SKILLS_ROOT', async () => {
    const otherUid = 'u2';
    const systemSkills = await import('../../../src/main/features/system_skills');
    const { getSystemSkillsPromptBlock } = await loadRegistry();
    await systemSkills.reconcileAllForUser(otherUid);

    const systemText = await getSystemSkillsPromptBlock(otherUid);
    expect(systemText).toContain(path.resolve(systemDirFor(otherUid)));
    expect(systemText).not.toContain(path.resolve(systemDir()));
    expect(fs.existsSync(path.join(systemDirFor(otherUid), 'agent-creator', 'SKILL.md'))).toBe(true);
  });

  it('can exclude a context-specific system skill without changing the catalog', async () => {
    writeSkill(systemDir(), 'agent-creator', 'agent-creator', 'Create agents');
    writeSkill(systemDir(), 'fixture-backlog-guide', 'fixture-backlog-guide', 'Manage the project backlog');
    const { getSystemSkillsPromptBlock } = await loadRegistry();

    const nonProjectText = await getSystemSkillsPromptBlock(
      TEST_UID,
      undefined,
      undefined,
      ['fixture-backlog-guide'],
    );
    const projectText = await getSystemSkillsPromptBlock(TEST_UID);

    expect(nonProjectText).toContain('**agent-creator**');
    expect(nonProjectText).not.toContain('**fixture-backlog-guide**');
    expect(projectText).toContain('**fixture-backlog-guide**');
  });

  it.each([1, 2])('uses one valid read example while binding %i system skills in the same run-scoped namespace', async (count) => {
    writeSkill(systemDir(), 'agent-creator', 'agent-creator', 'Create agents');
    if (count === 2) writeSkill(systemDir(), 'skill-creator', 'skill-creator', 'Create skills');
    const runtimeBindings = new Map();
    const { getSystemSkillsPromptBlock } = await loadRegistry();
    const text = await getSystemSkillsPromptBlock(undefined, runtimeBindings);

    // One JSON-shaped example works for both cardinalities; prose explicitly
    // requires a single batch rather than a separate call for each match.
    expect(text).toContain('Read all matches together in one call (one path entry per match):');
    expect(text).toContain('using the exact read refs on matching entries');
    const examples = [...text.matchAll(/`read_files\((\{[^\n]+\})\)`/g)];
    expect(examples).toHaveLength(1);
    expect(JSON.parse(examples[0][1])).toEqual({ paths: [{ path: '@skill/<read-ref>' }] });
    expect(runtimeBindings.size).toBe(count);
    if (count === 2) {
      expect(text).toContain('read ref: @skill/skill-creator');
      expect(runtimeBindings.get('skill-creator')).toMatchObject({
        id: 'skill-creator', source: 'system', root: path.join(path.resolve(systemDir()), 'skill-creator'),
      });
    }
    expect(text).toContain('read ref: @skill/agent-creator');
    expect(text).not.toContain('SYSTEM_SKILLS_ROOT');
    expect(runtimeBindings.get('agent-creator')).toMatchObject({
      id: 'agent-creator',
      source: 'system',
      root: path.join(path.resolve(systemDir()), 'agent-creator'),
    });
  });

  it('renders and binds only the host-allowlisted system skills', async () => {
    writeSkill(systemDir(), 'agent-creator', 'agent-creator', 'Create agents');
    writeSkill(systemDir(), 'package-installer', 'package-installer', 'Install packages');
    writeSkill(systemDir(), 'skill-creator', 'skill-creator', 'Create skills');
    const runtimeBindings = new Map();
    const { getSystemSkillsPromptBlock } = await loadRegistry();

    const text = await getSystemSkillsPromptBlock(
      undefined,
      runtimeBindings,
      ['skill-creator', 'package-installer'],
    );

    expect(text).toContain('**skill-creator**');
    expect(text).toContain('**package-installer**');
    expect(text).not.toContain('**agent-creator**');
    expect(runtimeBindings.has('skill-creator')).toBe(true);
    expect(runtimeBindings.has('package-installer')).toBe(true);
    expect(runtimeBindings.has('agent-creator')).toBe(false);

    const emptyBindings = new Map();
    const emptyText = await getSystemSkillsPromptBlock(undefined, emptyBindings, []);
    expect(emptyText).toBe('');
    expect(emptyBindings.size).toBe(0);
  });
});

describe('skill-registry › replaceKnownSkillIdsForDisplay', () => {
  it('rewrites known marketplace ids to display names with token boundaries', async () => {
    const { replaceKnownSkillIdsForDisplay } = await loadRegistry();
    const text = replaceKnownSkillIdsForDisplay(
      'skill: follow the `16e1bfcb3426` skill; leave x16e1bfcb3426y alone',
      [{ id: '16e1bfcb3426', name: 'agent-creator' }],
    );
    expect(text).toBe('skill: follow the `agent-creator` skill; leave x16e1bfcb3426y alone');
  });

  it('normalizes skill follow phrasing to a compact display reference', async () => {
    const { normalizeKnownSkillRefsForDisplay } = await loadRegistry();
    const text = normalizeKnownSkillRefsForDisplay(
      '`skill: follow the 16e1bfcb3426 skill` — create agents',
      [{ id: '16e1bfcb3426', name: 'agent-creator' }],
    );
    expect(text).toBe('`agent-creator` skill — create agents');
  });
});

describe('skill-registry › compactPromptDescription', () => {
  it('keeps the complete authored routing index below the safety boundary', async () => {
    const { compactPromptDescription } = await loadRegistry();
    const desc =
      '办公写作与交付入口：把用户想做、想改、想整理的办公材料落成可交付文档、表格、演示或 PDF；适合写报告。触发词：写文档';
    expect(compactPromptDescription(desc)).toBe(desc);
  });

  it('does not discard later routing clauses based on sentence shape or labels', async () => {
    const { compactPromptDescription } = await loadRegistry();
    const desc =
      '做视频，也剪视频。三条产线：①解说②AI 生成③剪辑你上传的真实视频。' +
      '凡是“对一段已有视频做处理”的都路由到它，而不是 commander 自己拿命令行拼。' +
      '适合“做个动画”。触发词：做视频、加字幕、剪辑';
    expect(compactPromptDescription(desc)).toBe(desc);
  });

  it('applies the shared visible cap without semantic rewriting', async () => {
    const { compactPromptDescription } = await loadRegistry();
    const long = '短。' + '这是一段没有触发段的很长描述内容用来测试上限。'.repeat(40);
    const out = compactPromptDescription(long);
    expect(estimateBudgetTokens(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('caps a long substantive summary instead of bypassing the ceiling', async () => {
    const { compactPromptDescription } = await loadRegistry();
    const exact = 'x'.repeat(800);
    const over = 'x'.repeat(801);

    expect(compactPromptDescription(exact)).toBe(exact);
    expect(compactPromptDescription(over)).toBe(`${'x'.repeat(799)}…`);
    expect(compactPromptDescription(over).endsWith('…')).toBe(true);

    const emojiAtBoundary = `${'x'.repeat(798)}🙂tail`;
    expect(compactPromptDescription(emojiAtBoundary)).toBe(`${'x'.repeat(798)}…`);
  });

  it('caps discovery surfaces without changing files or search over the omitted tail', async () => {
    const registry = await loadRegistry();
    const description = `${'x'.repeat(800)} tailkeyword`;
    writeSkill(customDir(), 'long-description', 'long-description', description);
    writeSkill(systemDir(), 'system-description', 'system-description', description);
    const files = [
      path.join(customDir(), 'long-description', 'SKILL.md'),
      path.join(systemDir(), 'system-description', 'SKILL.md'),
    ];
    const originals = files.map(file => fs.readFileSync(file, 'utf8'));
    const visible = `${'x'.repeat(799)}…`;
    const regular = await registry.getSystemPromptBlock();
    const system = await registry.getSystemSkillsPromptBlock(TEST_UID);
    for (const block of [regular, system]) {
      expect(block).toContain(visible);
      expect(block).not.toContain('tailkeyword');
    }
    const bridge = await registry.listSkillsForBridge(TEST_UID);
    expect(bridge.find(row => row.id === 'long-description')?.description).toBe(visible);
    // Search still indexes the full source, even though its returned row is capped.
    const search = await registry.searchAvailableSkills(TEST_UID, 'tailkeyword');
    expect(search.rows.map(row => row.id)).toEqual(['long-description']);
    expect(search.rows[0].description).toBe(visible);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(originals);
  });

  it('returns empty string for empty/whitespace input', async () => {
    const { compactPromptDescription } = await loadRegistry();
    expect(compactPromptDescription('   ')).toBe('');
    expect(compactPromptDescription('')).toBe('');
  });
});

describe('skill-registry › prompt-internal description language', () => {
  it('chooses English without rewriting content and falls back to Chinese', async () => {
    const { pickPromptDescription } = await loadRegistry();
    expect(pickPromptDescription({
      description_zh: '中文说明',
      description_en: 'English description',
    })).toBe('English description');
    expect(pickPromptDescription({
      description_zh: '仅中文说明',
      description_en: '',
    })).toBe('仅中文说明');
  });
});
