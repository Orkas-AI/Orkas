import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MARKETPLACE_RESOURCE_MANIFEST_NAME,
  marketplaceContentTreeFiles,
  marketplaceContentTreeHash,
} from '../../../src/main/util/marketplace-tree-hash';

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: postJsonMock,
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevBuiltin: string | undefined;
const TEST_AGENT_ID = '111111111111';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-builtin-marketplace-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevBuiltin = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.ORKAS_BUILTIN_ROOT = path.join(tmpDir, 'builtin');
  postJsonMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevBuiltin === undefined) delete process.env.ORKAS_BUILTIN_ROOT;
  else process.env.ORKAS_BUILTIN_ROOT = prevBuiltin;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function writeBuiltinAgent(dir: string, agentJson: Record<string, unknown>): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'agents', dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'agent.json'), JSON.stringify({ agent_id: dir, ...agentJson }, null, 2), 'utf8');
}

function writeBuiltinAgentMeta(dir: string, meta: Record<string, unknown>): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'agents', dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function writeBuiltinAgentSkill(agentDir: string, skillDir: string, name = skillDir): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'agents', agentDir, 'skills', skillDir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: private\n---\n\nprivate body\n`, 'utf8');
}

function writeBuiltinSkill(dir: string, name = dir): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'skills', dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: public\n---\n\npublic body\n`, 'utf8');
}

function writeBuiltinSkillMeta(dir: string, meta: Record<string, unknown>): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'skills', dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function writeResourceSeedManifest(dir: string, kind: 'agent' | 'skill', id: string): void {
  fs.writeFileSync(path.join(dir, MARKETPLACE_RESOURCE_MANIFEST_NAME), JSON.stringify({
    schemaVersion: 1,
    hashAlgorithm: 'sha256-tree-v1',
    kind,
    id,
    resource_hash: marketplaceContentTreeHash(dir),
    resource_online_hash: 'online-hash',
    files: marketplaceContentTreeFiles(dir),
  }, null, 2), 'utf8');
}

describe('builtin marketplace seed', () => {
  it('seeds agents and skills without requiring marketplace versions', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write.',
      skill_list: ['stage-plan'],
    });
    writeBuiltinAgentSkill(TEST_AGENT_ID, 'stage-plan', 'stage-plan');
    writeBuiltinSkill('seo-crawl', 'SEO Crawl');

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 1,
      seeded_skills: 1,
      manifest_agents: 1,
      manifest_skills: 1,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'), 'utf8'));
    expect(agentJson.agent_id).toBe(TEST_AGENT_ID);
    expect(fs.existsSync(path.join(paths.userMarketplaceAgentSkillsDir('u1', TEST_AGENT_ID), 'stage-plan', 'SKILL.md'))).toBe(true);

    const skillMeta = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceSkillDir('u1', 'seo-crawl'), '_install.json'), 'utf8'));
    expect(skillMeta).toMatchObject({
      version: '1.0.0',
      published_at: 0,
      bundle_url: '',
      create_uid: '0',
      default_install: true,
      seed_source: 'builtin',
    });

    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents).toEqual([
      expect.objectContaining({
        id: TEST_AGENT_ID,
        version: '1.0.0',
        agent_json_url: '',
        seed_source: 'builtin',
      }),
    ]);
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: 'seo-crawl',
        version: '1.0.0',
        bundle_url: '',
        seed_source: 'builtin',
      }),
    ]);

    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const agents = await import('../../../src/main/features/agents');
    const skills = await import('../../../src/main/features/skills');
    expect((await agents.listAgents()).find((a) => a.agent_id === TEST_AGENT_ID)?.version).toBe('1.0.0');
    expect((await skills.listSkills()).find((s) => s.id === 'seo-crawl')?.version).toBe('1.0.0');
  });

  it('refreshes builtin agent content when the packaged version is newer', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write old.',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');
    const localAgentDir = paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID);
    fs.writeFileSync(path.join(localAgentDir, 'runtime-note.txt'), 'keep me\n', 'utf8');
    const initialMetaPath = path.join(localAgentDir, '_install.json');
    const initialMeta = JSON.parse(fs.readFileSync(initialMetaPath, 'utf8'));
    fs.writeFileSync(initialMetaPath, JSON.stringify({
      ...initialMeta,
      status: 'approved',
    }, null, 2), 'utf8');

    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.1.0',
      name: 'Writer',
      description: 'Writes things better',
      category: 'general',
      workflow: 'Write new.',
      updated_at: '2026-01-02T00:00:00Z',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 0,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'), 'utf8'));
    expect(agentJson.version).toBe('1.1.0');
    expect(agentJson.workflow).toBe('Write new.');
    expect(fs.readFileSync(path.join(localAgentDir, 'runtime-note.txt'), 'utf8')).toBe('keep me\n');
    const meta = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), '_install.json'), 'utf8'));
    expect(meta.version).toBe('1.1.0');
    expect(meta.seed_source).toBe('builtin');
    expect(meta.status).toBe('approved');
    expect(meta.builtin_files).toContain('agent.json');
    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents[0]).toMatchObject({
      id: TEST_AGENT_ID,
      version: '1.1.0',
      seed_source: 'builtin',
    });
  });

  it('refreshes builtin agent content when version is equal but packaged updated_at is newer', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write old.',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    await seed.seedBuiltinMarketplaceForUser('u1');

    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write revised.',
      updated_at: '2026-01-03T00:00:00Z',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 0,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'), 'utf8'));
    expect(agentJson.workflow).toBe('Write revised.');
  });

  it('refreshes builtin agent content when the local install has no version', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write old.',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    await seed.seedBuiltinMarketplaceForUser('u1');

    const localRoot = paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID);
    fs.writeFileSync(path.join(localRoot, 'agent.json'), JSON.stringify({
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Local stale copy',
      category: 'general',
      workflow: 'Write stale.',
    }, null, 2), 'utf8');
    const metaPath = path.join(localRoot, '_install.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.version;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write restored.',
      updated_at: '2026-01-01T00:00:00Z',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 0,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(localRoot, 'agent.json'), 'utf8'));
    expect(agentJson.workflow).toBe('Write restored.');
    const refreshedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(refreshedMeta.version).toBe('1.0.0');
  });

  it('does not overwrite resolved marketplace agent content when packaged builtin is not newer', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write bundled.',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');
    const localUpdatedAt = Date.parse('2026-01-05T00:00:00Z');
    await installs.addAgentInstall('u1', {
      id: TEST_AGENT_ID,
      version: '1.0.0',
      published_at: localUpdatedAt,
      agent_json_url: 'https://cdn.test/writer.json',
      agent_skills_bundle_url: '',
      create_uid: '0',
      default_install: true,
    });
    const officialAgentJson = JSON.stringify({
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Official copy',
      category: 'general',
      workflow: 'Write official.',
    }, null, 2);
    const localAgentDir = paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID);
    fs.writeFileSync(path.join(localAgentDir, 'agent.json'), officialAgentJson, 'utf8');
    fs.writeFileSync(path.join(localAgentDir, '_install.json'), JSON.stringify({
      version: '1.0.0',
      published_at: localUpdatedAt,
      agent_json_url: 'https://cdn.test/writer.json',
      agent_skills_bundle_url: '',
      installed_at: 12,
      create_uid: '0',
      default_install: true,
      content_sha: sha256(officialAgentJson),
    }, null, 2), 'utf8');

    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Bundled same-version copy',
      category: 'general',
      workflow: 'Write bundled same version.',
      updated_at: '2026-01-04T00:00:00Z',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 0,
      manifest_agents: 0,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'), 'utf8'));
    expect(agentJson.workflow).toBe('Write official.');
  });

  it('overlays newer builtin agent content onto a lower-version marketplace install', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write bundled.',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');
    await installs.addAgentInstall('u1', {
      id: TEST_AGENT_ID,
      version: '1.0.0',
      published_at: 10,
      updated_at: 10,
      agent_json_url: 'https://cdn.test/writer.json',
      agent_skills_bundle_url: '',
      create_uid: '0',
      default_install: true,
    });
    const officialAgentJson = JSON.stringify({
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Official copy',
      category: 'general',
      workflow: 'Write official.',
    }, null, 2);
    const localAgentDir = paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID);
    fs.writeFileSync(path.join(localAgentDir, 'agent.json'), officialAgentJson, 'utf8');
    fs.writeFileSync(path.join(localAgentDir, '_install.json'), JSON.stringify({
      version: '1.0.0',
      published_at: 10,
      updated_at: 10,
      agent_json_url: 'https://cdn.test/writer.json',
      agent_skills_bundle_url: '',
      installed_at: 12,
      create_uid: '0',
      default_install: true,
      content_sha: sha256(officialAgentJson),
    }, null, 2), 'utf8');

    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.1.0',
      name: 'Writer',
      description: 'Bundled newer copy',
      category: 'general',
      workflow: 'Write bundled newer.',
      updated_at: '2026-01-04T00:00:00Z',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 0,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(localAgentDir, 'agent.json'), 'utf8'));
    expect(agentJson.version).toBe('1.1.0');
    expect(agentJson.workflow).toBe('Write bundled newer.');
    const meta = JSON.parse(fs.readFileSync(path.join(localAgentDir, '_install.json'), 'utf8'));
    expect(meta).toMatchObject({
      version: '1.1.0',
      seed_source: 'builtin',
      agent_json_url: 'https://cdn.test/writer.json',
    });
  });

  it('overlays newer builtin agent content even when the marketplace install was locally edited', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      agent_id: TEST_AGENT_ID,
      version: '1.1.0',
      name: 'Writer',
      description: 'Bundled newer copy',
      category: 'general',
      workflow: 'Write bundled newer.',
      updated_at: '2026-01-04T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: TEST_AGENT_ID,
      version: '1.0.0',
      published_at: 10,
      updated_at: 10,
      agent_json_url: 'https://cdn.test/writer.json',
      agent_skills_bundle_url: '',
      create_uid: '0',
      default_install: true,
    });

    const originalAgentJson = JSON.stringify({
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Official copy',
      category: 'general',
      workflow: 'Write official.',
    }, null, 2);
    const editedAgentJson = JSON.stringify({
      agent_id: TEST_AGENT_ID,
      version: '1.0.0',
      name: 'Writer',
      description: 'Locally edited copy',
      category: 'general',
      workflow: 'Write locally edited.',
    }, null, 2);
    const localAgentDir = paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID);
    fs.mkdirSync(localAgentDir, { recursive: true });
    fs.writeFileSync(path.join(localAgentDir, 'agent.json'), editedAgentJson, 'utf8');
    fs.writeFileSync(path.join(localAgentDir, '_install.json'), JSON.stringify({
      version: '1.0.0',
      published_at: 10,
      updated_at: 10,
      agent_json_url: 'https://cdn.test/writer.json',
      agent_skills_bundle_url: '',
      installed_at: 12,
      create_uid: '0',
      default_install: true,
      content_sha: sha256(originalAgentJson),
    }, null, 2), 'utf8');

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 0,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(localAgentDir, 'agent.json'), 'utf8'));
    expect(agentJson.version).toBe('1.1.0');
    expect(agentJson.workflow).toBe('Write bundled newer.');
    const meta = JSON.parse(fs.readFileSync(path.join(localAgentDir, '_install.json'), 'utf8'));
    expect(meta).toMatchObject({
      version: '1.1.0',
      seed_source: 'builtin',
      agent_json_url: 'https://cdn.test/writer.json',
    });
  });

  it('refreshes builtin skill content without replacing local-only files', async () => {
    writeBuiltinSkill('ee99fbb42964', 'deep-research');
    writeBuiltinSkillMeta('ee99fbb42964', {
      version: '1.0.1',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');

    const localRoot = paths.userMarketplaceSkillDir('u1', 'ee99fbb42964');
    fs.writeFileSync(path.join(localRoot, 'runtime-note.txt'), 'keep me\n', 'utf8');
    const builtinRoot = path.join(tmpDir, 'builtin', 'marketplace', 'skills', 'ee99fbb42964');
    fs.mkdirSync(path.join(builtinRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, 'scripts', 'guard.py'), 'print("ok")\n', 'utf8');
    writeBuiltinSkillMeta('ee99fbb42964', {
      version: '1.0.1',
      updated_at: '2026-01-02T00:00:00Z',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 0,
    });

    expect(fs.existsSync(path.join(localRoot, 'scripts', 'guard.py'))).toBe(true);
    expect(fs.readFileSync(path.join(localRoot, 'runtime-note.txt'), 'utf8')).toBe('keep me\n');
    const meta = JSON.parse(fs.readFileSync(path.join(localRoot, '_install.json'), 'utf8'));
    expect(meta.seed_source).toBe('builtin');
    expect(meta.version).toBe('1.0.1');
    expect(meta.updated_at).toBe(Date.parse('2026-01-02T00:00:00Z'));
    expect(meta.content_tree_hash).toEqual(expect.any(String));
    expect(meta.builtin_files).toContain('scripts/guard.py');
    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills[0]).toMatchObject({
      id: 'ee99fbb42964',
      version: '1.0.1',
      updated_at: Date.parse('2026-01-02T00:00:00Z'),
      seed_source: 'builtin',
    });
  });

  it('refreshes builtin skill seed when packaged version is newer even after local edits', async () => {
    const skillId = 'ee99fbb42964';
    writeBuiltinSkill(skillId, 'deep-research');
    writeBuiltinSkillMeta(skillId, { version: '1.0.0' });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    await seed.seedBuiltinMarketplaceForUser('u1');

    const localRoot = paths.userMarketplaceSkillDir('u1', skillId);
    fs.writeFileSync(
      path.join(localRoot, 'SKILL.md'),
      '---\nname: deep-research\ndescription: edited\n---\n\nlocal edit\n',
      'utf8',
    );

    const builtinRoot = path.join(tmpDir, 'builtin', 'marketplace', 'skills', skillId);
    fs.writeFileSync(
      path.join(builtinRoot, 'SKILL.md'),
      '---\nname: deep-research\ndescription: newer\n---\n\nnew builtin body\n',
      'utf8',
    );
    writeBuiltinSkillMeta(skillId, { version: '1.0.1' });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 0,
    });

    expect(fs.readFileSync(path.join(localRoot, 'SKILL.md'), 'utf8')).toBe(
      '---\nname: deep-research\ndescription: newer\n---\n\nnew builtin body\n',
    );
    const meta = JSON.parse(fs.readFileSync(path.join(localRoot, '_install.json'), 'utf8'));
    expect(meta).toMatchObject({
      version: '1.0.1',
      seed_source: 'builtin',
    });
  });

  it('refreshes builtin skill content when the local install has no version', async () => {
    const skillId = 'ee99fbb42964';
    writeBuiltinSkill(skillId, 'deep-research');
    writeBuiltinSkillMeta(skillId, {
      version: '1.0.1',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    await seed.seedBuiltinMarketplaceForUser('u1');

    const localRoot = paths.userMarketplaceSkillDir('u1', skillId);
    fs.writeFileSync(
      path.join(localRoot, 'SKILL.md'),
      '---\nname: deep-research\ndescription: edited\n---\n\nlocal edit\n',
      'utf8',
    );
    const metaPath = path.join(localRoot, '_install.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.version;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

    const builtinRoot = path.join(tmpDir, 'builtin', 'marketplace', 'skills', skillId);
    fs.writeFileSync(
      path.join(builtinRoot, 'SKILL.md'),
      '---\nname: deep-research\ndescription: public\n---\n\nrestored builtin body\n',
      'utf8',
    );

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 0,
    });

    expect(fs.readFileSync(path.join(localRoot, 'SKILL.md'), 'utf8')).toBe(
      '---\nname: deep-research\ndescription: public\n---\n\nrestored builtin body\n',
    );
    const refreshedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(refreshedMeta.version).toBe('1.0.1');
    expect(refreshedMeta.updated_at).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('refreshes legacy builtin skill seeds that predate seed_source and tree hashes', async () => {
    const skillId = 'ee99fbb42964';
    writeBuiltinSkill(skillId, 'deep-research');
    writeBuiltinSkillMeta(skillId, { version: '1.0.1' });
    const builtinRoot = path.join(tmpDir, 'builtin', 'marketplace', 'skills', skillId);
    fs.mkdirSync(path.join(builtinRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, 'scripts', 'guard.py'), 'print("ok")\n', 'utf8');

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    const localRoot = paths.userMarketplaceSkillDir('u1', skillId);
    const oldSkill = '---\nname: deep-research\ndescription: public\n---\n\npublic body\n';
    fs.mkdirSync(localRoot, { recursive: true });
    fs.writeFileSync(path.join(localRoot, 'SKILL.md'), oldSkill, 'utf8');
    fs.writeFileSync(path.join(localRoot, '_install.json'), JSON.stringify({
      version: '1.0.0',
      published_at: 0,
      bundle_url: '',
      installed_at: 12,
      create_uid: '0',
      content_sha: sha256(oldSkill),
    }, null, 2), 'utf8');
    await installs.addSkillInstall('u1', {
      id: skillId,
      version: '1.0.0',
      published_at: 0,
      bundle_url: '',
      installed_at: 12,
      create_uid: '0',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 0,
    });

    expect(fs.existsSync(path.join(localRoot, 'scripts', 'guard.py'))).toBe(true);
    const localMeta = JSON.parse(fs.readFileSync(path.join(localRoot, '_install.json'), 'utf8'));
    expect(localMeta).toMatchObject({
      version: '1.0.1',
      seed_source: 'builtin',
      bundle_url: '',
    });
    expect(localMeta.content_tree_hash).toEqual(expect.any(String));
    expect(localMeta.builtin_files).toContain('scripts/guard.py');
    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills[0]).toMatchObject({
      id: skillId,
      version: '1.0.1',
      seed_source: 'builtin',
    });
  });

  it('re-seeds a builtin skill when packaged metadata supersedes an old uninstall tombstone', async () => {
    const skillId = 'ee99fbb42964';
    writeBuiltinSkill(skillId, 'deep-research');
    writeBuiltinSkillMeta(skillId, {
      version: '1.0.1',
      reseed_if_deleted_before: '2026-07-03T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.writeInstalls('u1', {
      version: installs.CURRENT_VERSION,
      agents: [],
      skills: [],
      _deleted_at: {
        skills: { [skillId]: Date.parse('2026-07-02T23:59:59Z') },
      },
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 1,
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir('u1', skillId), 'SKILL.md'))).toBe(true);
    const manifest = await installs.readInstalls('u1');
    expect(manifest._deleted_at?.skills?.[skillId]).toBeUndefined();
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: skillId,
        version: '1.0.1',
        seed_source: 'builtin',
      }),
    ]);
  });

  it('re-seeds a builtin agent when packaged metadata supersedes an old uninstall tombstone', async () => {
    const agentId = '78900d8758bc';
    writeBuiltinAgent(agentId, {
      version: '1.0.2',
      name: 'DeepResearcher',
      description: 'Research deeply',
      category: 'data',
      workflow: 'Research.',
      updated_at: '2026-07-04T00:00:00Z',
    });
    writeBuiltinAgentMeta(agentId, {
      reseed_if_deleted_before: '2026-07-05T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.writeInstalls('u1', {
      version: installs.CURRENT_VERSION,
      agents: [],
      skills: [],
      _deleted_at: {
        agents: { [agentId]: Date.parse('2026-07-04T23:59:59Z') },
      },
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 1,
    });

    const agentJson = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir('u1', agentId), 'agent.json'), 'utf8'));
    expect(agentJson.name).toBe('DeepResearcher');
    const manifest = await installs.readInstalls('u1');
    expect(manifest._deleted_at?.agents?.[agentId]).toBeUndefined();
    expect(manifest.agents).toEqual([
      expect.objectContaining({
        id: agentId,
        version: '1.0.2',
        seed_source: 'builtin',
      }),
    ]);
  });

  it('keeps a newer builtin agent uninstall tombstone respected', async () => {
    const agentId = '78900d8758bc';
    writeBuiltinAgent(agentId, {
      version: '1.0.2',
      name: 'DeepResearcher',
      description: 'Research deeply',
      category: 'data',
      workflow: 'Research.',
      updated_at: '2026-07-04T00:00:00Z',
    });
    writeBuiltinAgentMeta(agentId, {
      reseed_if_deleted_before: '2026-07-05T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.writeInstalls('u1', {
      version: installs.CURRENT_VERSION,
      agents: [],
      skills: [],
      _deleted_at: {
        agents: { [agentId]: Date.parse('2026-07-05T00:00:00Z') },
      },
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_agents: 0,
      manifest_agents: 0,
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceAgentDir('u1', agentId), 'agent.json'))).toBe(false);
    const manifest = await installs.readInstalls('u1');
    expect(manifest._deleted_at?.agents?.[agentId]).toEqual(Date.parse('2026-07-05T00:00:00Z'));
    expect(manifest.agents).toEqual([]);
  });

  it('keeps a newer builtin skill uninstall tombstone respected', async () => {
    const skillId = 'ee99fbb42964';
    writeBuiltinSkill(skillId, 'deep-research');
    writeBuiltinSkillMeta(skillId, {
      version: '1.0.1',
      reseed_if_deleted_before: '2026-07-03T00:00:00Z',
    });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.writeInstalls('u1', {
      version: installs.CURRENT_VERSION,
      agents: [],
      skills: [],
      _deleted_at: {
        skills: { [skillId]: Date.parse('2026-07-03T00:00:00Z') },
      },
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 0,
      manifest_skills: 0,
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir('u1', skillId), 'SKILL.md'))).toBe(false);
    const manifest = await installs.readInstalls('u1');
    expect(manifest._deleted_at?.skills?.[skillId]).toEqual(Date.parse('2026-07-03T00:00:00Z'));
    expect(manifest.skills).toEqual([]);
  });

  it('overlays newer builtin skill content onto a lower-version marketplace install', async () => {
    const skillId = 'ee99fbb42964';
    writeBuiltinSkill(skillId, 'deep-research');
    const builtinRoot = path.join(tmpDir, 'builtin', 'marketplace', 'skills', skillId);
    writeBuiltinSkillMeta(skillId, { version: '1.0.1' });
    fs.mkdirSync(path.join(builtinRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, 'scripts', 'guard.py'), 'print("ok")\n', 'utf8');

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    const localRoot = paths.userMarketplaceSkillDir('u1', skillId);
    fs.mkdirSync(localRoot, { recursive: true });
    const oldSkill = '---\nname: deep-research\ndescription: old\n---\n\nold body\n';
    fs.writeFileSync(path.join(localRoot, 'SKILL.md'), oldSkill, 'utf8');
    fs.writeFileSync(path.join(localRoot, 'runtime-note.txt'), 'keep me\n', 'utf8');
    fs.writeFileSync(path.join(localRoot, '_install.json'), JSON.stringify({
      version: '1.0.0',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/deep-research.zip',
      installed_at: 12,
      create_uid: '0',
      default_install: false,
      status: 'approved',
      content_sha: sha256(oldSkill),
    }, null, 2), 'utf8');
    await installs.addSkillInstall('u1', {
      id: skillId,
      version: '1.0.0',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/deep-research.zip',
      installed_at: 12,
      create_uid: '0',
      default_install: false,
      status: 'approved',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 0,
    });

    expect(fs.readFileSync(path.join(localRoot, 'runtime-note.txt'), 'utf8')).toBe('keep me\n');
    expect(fs.existsSync(path.join(localRoot, 'scripts', 'guard.py'))).toBe(true);
    const localMeta = JSON.parse(fs.readFileSync(path.join(localRoot, '_install.json'), 'utf8'));
    expect(localMeta).toMatchObject({
      version: '1.0.1',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/deep-research.zip',
      installed_at: 12,
      create_uid: '0',
      default_install: false,
      status: 'approved',
      seed_source: 'builtin',
    });
    expect(localMeta.content_sha).toEqual(expect.any(String));
    expect(localMeta.content_tree_hash).toEqual(expect.any(String));
    expect(localMeta.builtin_files).toContain('scripts/guard.py');

    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: skillId,
        version: '1.0.0',
        bundle_url: 'https://cdn.test/deep-research.zip',
      }),
    ]);
    expect((manifest.skills[0] as any).seed_source).toBeUndefined();

    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const skills = await import('../../../src/main/features/skills');
    expect((await skills.listSkills()).find((s) => s.id === skillId)?.version).toBe('1.0.1');
  });

  it('does not hand off a resource-owned marketplace skill when packaged builtin is not newer', async () => {
    const skillId = '9be6fda271a5';
    writeBuiltinSkill(skillId, 'material-organizer');
    writeBuiltinSkillMeta(skillId, { version: '1.0.1' });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    const localRoot = paths.userMarketplaceSkillDir('u1', skillId);
    fs.mkdirSync(localRoot, { recursive: true });
    const skillBody = '---\nname: material-organizer\ndescription: public\n---\n\npublic body\n';
    fs.writeFileSync(path.join(localRoot, 'SKILL.md'), skillBody, 'utf8');
    writeResourceSeedManifest(localRoot, 'skill', skillId);
    fs.writeFileSync(path.join(localRoot, '_install.json'), JSON.stringify({
      version: '1.0.1',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/material-organizer.zip',
      installed_at: 12,
      create_uid: '0',
      default_install: false,
      status: 'approved',
      content_sha: sha256(skillBody),
      seed_source: 'resource',
    }, null, 2), 'utf8');
    await installs.addSkillInstall('u1', {
      id: skillId,
      version: '1.0.0',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/material-organizer.zip',
      installed_at: 12,
      create_uid: '0',
      default_install: false,
      status: 'approved',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 0,
      manifest_skills: 0,
    });

    expect(fs.readFileSync(path.join(localRoot, 'SKILL.md'), 'utf8')).toBe(skillBody);
    expect(fs.existsSync(path.join(localRoot, MARKETPLACE_RESOURCE_MANIFEST_NAME))).toBe(true);
    const localMeta = JSON.parse(fs.readFileSync(path.join(localRoot, '_install.json'), 'utf8'));
    expect(localMeta).toMatchObject({
      version: '1.0.1',
      bundle_url: 'https://cdn.test/material-organizer.zip',
      seed_source: 'resource',
    });
    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills[0]).toMatchObject({
      id: skillId,
      version: '1.0.0',
      bundle_url: 'https://cdn.test/material-organizer.zip',
    });
    expect((manifest.skills[0] as any).seed_source).toBeUndefined();
  });

  it('overlays newer builtin skill over a resource-owned marketplace skill even after local edits', async () => {
    const skillId = '6743aa0797a2';
    writeBuiltinSkill(skillId, 'brand-research');
    writeBuiltinSkillMeta(skillId, { version: '1.0.2' });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    const localRoot = paths.userMarketplaceSkillDir('u1', skillId);
    fs.mkdirSync(localRoot, { recursive: true });
    const originalSkill = '---\nname: brand-research\ndescription: public\n---\n\npublic body\n';
    const editedSkill = '---\nname: brand-research\ndescription: edited\n---\n\nlocal edit\n';
    fs.writeFileSync(path.join(localRoot, 'SKILL.md'), originalSkill, 'utf8');
    writeResourceSeedManifest(localRoot, 'skill', skillId);
    fs.writeFileSync(path.join(localRoot, 'SKILL.md'), editedSkill, 'utf8');
    fs.writeFileSync(path.join(localRoot, '_install.json'), JSON.stringify({
      version: '1.0.1',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/brand-research.zip',
      installed_at: 12,
      create_uid: '0',
      content_sha: sha256(originalSkill),
      seed_source: 'resource',
    }, null, 2), 'utf8');
    await installs.addSkillInstall('u1', {
      id: skillId,
      version: '1.0.0',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/brand-research.zip',
      installed_at: 12,
      create_uid: '0',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 0,
    });

    expect(fs.readFileSync(path.join(localRoot, 'SKILL.md'), 'utf8')).toBe(originalSkill);
    const localMeta = JSON.parse(fs.readFileSync(path.join(localRoot, '_install.json'), 'utf8'));
    expect(localMeta).toMatchObject({
      version: '1.0.2',
      seed_source: 'builtin',
      bundle_url: 'https://cdn.test/brand-research.zip',
    });
    expect(fs.existsSync(path.join(localRoot, MARKETPLACE_RESOURCE_MANIFEST_NAME))).toBe(false);
  });

  it('overlays newer builtin skill content even when the marketplace install was locally edited', async () => {
    const skillId = 'ee99fbb42964';
    writeBuiltinSkill(skillId, 'deep-research');
    const builtinRoot = path.join(tmpDir, 'builtin', 'marketplace', 'skills', skillId);
    writeBuiltinSkillMeta(skillId, { version: '1.0.1' });

    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    const localRoot = paths.userMarketplaceSkillDir('u1', skillId);
    fs.mkdirSync(localRoot, { recursive: true });
    const originalSkill = '---\nname: deep-research\ndescription: old\n---\n\nold body\n';
    const editedSkill = '---\nname: deep-research\ndescription: edited\n---\n\nlocal edit\n';
    fs.writeFileSync(path.join(localRoot, 'SKILL.md'), editedSkill, 'utf8');
    fs.writeFileSync(path.join(localRoot, '_install.json'), JSON.stringify({
      version: '1.0.0',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/deep-research.zip',
      installed_at: 12,
      create_uid: '0',
      content_sha: sha256(originalSkill),
    }, null, 2), 'utf8');
    await installs.addSkillInstall('u1', {
      id: skillId,
      version: '1.0.0',
      published_at: 10,
      updated_at: 11,
      bundle_url: 'https://cdn.test/deep-research.zip',
      installed_at: 12,
      create_uid: '0',
    });

    await expect(seed.seedBuiltinMarketplaceForUser('u1')).resolves.toMatchObject({
      seeded_skills: 1,
      manifest_skills: 0,
    });

    expect(fs.readFileSync(path.join(localRoot, 'SKILL.md'), 'utf8')).toBe('---\nname: deep-research\ndescription: public\n---\n\npublic body\n');
    const localMeta = JSON.parse(fs.readFileSync(path.join(localRoot, '_install.json'), 'utf8'));
    expect(localMeta).toMatchObject({
      version: '1.0.1',
      seed_source: 'builtin',
      bundle_url: 'https://cdn.test/deep-research.zip',
    });
  });

  it('resolves builtin skill seed rows to official marketplace rows by exact id', async () => {
    writeBuiltinSkill('seo-crawl', 'SEO Crawl');
    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');

    postJsonMock.mockImplementation(async (p: string, body: any) => {
      if (p === '/marketplace/skills/list' && Array.isArray(body?.ids)) {
        return {
          list: [{
            id: 'seo-crawl',
            name: 'SEO Crawl',
            version: '2.0.0',
            published_at: 100,
            updated_at: 200,
            create_uid: '0',
            default_install: true,
            status: 'approved',
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/skills/bundle' && body?.id === 'seo-crawl') {
        return {
          bundle_url: 'https://cdn.test/seo-crawl.zip',
          version: '2.0.0',
          published_at: 100,
          updated_at: 200,
          create_uid: '0',
          default_install: true,
          status: 'approved',
        };
      }
      throw new Error(`unexpected ${p}`);
    });

    await expect(seed.resolveBuiltinMarketplaceInstalls('u1')).resolves.toMatchObject({
      resolved_skills: 1,
      migrated_skills: 0,
      failed: [],
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir('u1', 'seo-crawl'), 'SKILL.md'))).toBe(true);

    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: 'seo-crawl',
        version: '2.0.0',
        published_at: 100,
        updated_at: 200,
        bundle_url: 'https://cdn.test/seo-crawl.zip',
      }),
    ]);
    expect((manifest.skills[0] as any).seed_source).toBeUndefined();

    const localMeta = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceSkillDir('u1', 'seo-crawl'), '_install.json'), 'utf8'));
    expect(localMeta).toMatchObject({
      version: '1.0.0',
      published_at: 0,
      seed_source: 'builtin',
    });
  });

  it('does not resolve builtin skills by display name to a different marketplace id', async () => {
    writeBuiltinSkill('ee99fbb42964', 'deep-research');
    const seed = await import('../../../src/main/features/builtin_marketplace');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');

    postJsonMock.mockImplementation(async (p: string, body: any) => {
      if (p === '/marketplace/skills/list' && Array.isArray(body?.ids)) {
        return { list: [], total: 0 };
      }
      if (p === '/marketplace/skills/list' && body?.q === 'deep-research') {
        return {
          list: [{
            id: 'ee99fbb42964',
            name: 'deep-research',
            version: '2.0.0',
            published_at: 100,
            updated_at: 200,
            create_uid: '0',
            default_install: true,
            status: 'approved',
          }],
          total: 1,
        };
      }
      throw new Error(`unexpected ${p}`);
    });

    await expect(seed.resolveBuiltinMarketplaceInstalls('u1')).resolves.toMatchObject({
      resolved_skills: 0,
      migrated_skills: 0,
      failed: [],
    });

    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(postJsonMock).toHaveBeenCalledWith('/marketplace/skills/list', {
      page: 1,
      size: 100,
      ids: ['ee99fbb42964'],
    });

    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: 'ee99fbb42964',
        bundle_url: '',
        seed_source: 'builtin',
      }),
    ]);
  });

  it('rewrites migrated builtin agent fallback content to the official marketplace id', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write.',
    });
    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');

    postJsonMock.mockImplementation(async (p: string, body: any) => {
      if (p === '/marketplace/agents/list' && Array.isArray(body?.ids)) {
        return { list: [], total: 0 };
      }
      if (p === '/marketplace/agents/list' && body?.q === 'Writer') {
        return {
          list: [{
            id: 'abc123def456',
            name: 'Writer',
            version: '2.0.0',
            published_at: 100,
            updated_at: 200,
            create_uid: '0',
            default_install: true,
            status: 'approved',
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/agents/detail' && body?.id === 'abc123def456') {
        return {
          agent_json_url: 'https://cdn.test/abc123def456.json',
          version: '2.0.0',
          published_at: 100,
          updated_at: 200,
          create_uid: '0',
          default_install: true,
          status: 'approved',
        };
      }
      throw new Error(`unexpected ${p}`);
    });

    await expect(seed.resolveBuiltinMarketplaceInstalls('u1')).resolves.toMatchObject({
      resolved_agents: 1,
      migrated_agents: 1,
      failed: [],
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'))).toBe(false);
    const agentJson = JSON.parse(fs.readFileSync(path.join(paths.userMarketplaceAgentDir('u1', 'abc123def456'), 'agent.json'), 'utf8'));
    expect(agentJson.agent_id).toBe('abc123def456');

    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents).toEqual([
      expect.objectContaining({
        id: 'abc123def456',
        version: '2.0.0',
        agent_json_url: 'https://cdn.test/abc123def456.json',
      }),
    ]);
    expect((manifest.agents[0] as any).seed_source).toBeUndefined();
  });

  it('does not delete a builtin agent seed when id migration destination already exists', async () => {
    const officialId = 'abc123def456';
    writeBuiltinAgent(TEST_AGENT_ID, {
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Write fallback.',
    });
    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');

    const officialDir = paths.userMarketplaceAgentDir('u1', officialId);
    fs.mkdirSync(officialDir, { recursive: true });
    fs.writeFileSync(path.join(officialDir, 'agent.json'), JSON.stringify({
      agent_id: officialId,
      name: 'Existing Writer',
      workflow: 'Keep existing destination.',
    }, null, 2), 'utf8');

    postJsonMock.mockImplementation(async (p: string, body: any) => {
      if (p === '/marketplace/agents/list' && Array.isArray(body?.ids)) {
        return { list: [], total: 0 };
      }
      if (p === '/marketplace/agents/list' && body?.q === 'Writer') {
        return {
          list: [{
            id: officialId,
            name: 'Writer',
            version: '2.0.0',
            published_at: 100,
            updated_at: 200,
            create_uid: '0',
            default_install: true,
            status: 'approved',
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/agents/detail' && body?.id === officialId) {
        return {
          agent_json_url: 'https://cdn.test/abc123def456.json',
          version: '2.0.0',
          published_at: 100,
          updated_at: 200,
          create_uid: '0',
          default_install: true,
          status: 'approved',
        };
      }
      throw new Error(`unexpected ${p}`);
    });

    await expect(seed.resolveBuiltinMarketplaceInstalls('u1')).resolves.toMatchObject({
      resolved_agents: 0,
      migrated_agents: 0,
      failed: [`agent:${TEST_AGENT_ID}`],
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'))).toBe(true);
    const destination = JSON.parse(fs.readFileSync(path.join(officialDir, 'agent.json'), 'utf8'));
    expect(destination.workflow).toBe('Keep existing destination.');
    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents).toEqual([
      expect.objectContaining({
        id: TEST_AGENT_ID,
        agent_json_url: '',
        seed_source: 'builtin',
      }),
    ]);
  });

  it('does not delete a builtin skill seed when id migration destination already exists', async () => {
    writeBuiltinSkill('legacy-skill', 'Legacy Skill');
    const seed = await import('../../../src/main/features/builtin_marketplace');
    const paths = await import('../../../src/main/paths');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await seed.seedBuiltinMarketplaceForUser('u1');

    const officialDir = paths.userMarketplaceSkillDir('u1', 'official-skill');
    fs.mkdirSync(officialDir, { recursive: true });
    fs.writeFileSync(path.join(officialDir, 'SKILL.md'), '---\nname: existing\ndescription: keep\n---\n\nkeep\n', 'utf8');

    postJsonMock.mockImplementation(async (p: string, body: any) => {
      if (p === '/marketplace/skills/list' && Array.isArray(body?.ids)) {
        return {
          list: [{
            id: 'official-skill',
            name: 'Legacy Skill',
            version: '2.0.0',
            published_at: 100,
            updated_at: 200,
            create_uid: '0',
            default_install: true,
            status: 'approved',
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/skills/bundle' && body?.id === 'official-skill') {
        return {
          bundle_url: 'https://cdn.test/official-skill.zip',
          version: '2.0.0',
          published_at: 100,
          updated_at: 200,
          create_uid: '0',
          default_install: true,
          status: 'approved',
        };
      }
      throw new Error(`unexpected ${p}`);
    });

    await expect(seed.resolveBuiltinMarketplaceInstalls('u1')).resolves.toMatchObject({
      resolved_skills: 0,
      migrated_skills: 0,
      failed: ['skill:legacy-skill'],
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceSkillDir('u1', 'legacy-skill'), 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(officialDir, 'SKILL.md'), 'utf8')).toContain('keep');
    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: 'legacy-skill',
        bundle_url: '',
        seed_source: 'builtin',
      }),
    ]);
  });

  it('renders installed agent-private builtin skills only for the owning agent', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      name: 'Writer',
      description: 'Writes things',
      category: 'general',
      workflow: 'Use private stages.',
    });
    writeBuiltinAgentSkill(TEST_AGENT_ID, 'stage-plan', 'stage-plan');

    const seed = await import('../../../src/main/features/builtin_marketplace');
    await seed.seedBuiltinMarketplaceForUser('u1');
    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const registry = await import('../../../src/main/model/core-agent/skill-registry');

    const ownerBlock = await registry.getSystemPromptBlock({ agentId: TEST_AGENT_ID });
    expect(ownerBlock).toContain('- agent:');
    expect(ownerBlock).toContain('**stage-plan**');
    expect((await registry.listSkillSpecs({ forAgentId: TEST_AGENT_ID })).some((s) => s.id === 'stage-plan')).toBe(true);

    const commanderBlock = await registry.getSystemPromptBlock();
    expect(commanderBlock).not.toContain('**stage-plan**');
  });

  it('renders custom agent private skills from private_skills without exposing self-evolved skills', async () => {
    const paths = await import('../../../src/main/paths');
    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');

    const privateRoot = path.join(paths.agentPrivateSkillsDir('u1', 'custom-writer'), 'draft-helper');
    fs.mkdirSync(privateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(privateRoot, 'SKILL.md'),
      '---\nname: draft-helper\ndescription: custom private\n---\n\nprivate body\n',
      'utf8',
    );
    const evolvedRoot = path.join(paths.agentEvolvedSkillsDir('u1', 'custom-writer'), 'evolved-helper');
    fs.mkdirSync(evolvedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(evolvedRoot, 'SKILL.md'),
      '---\nname: evolved-helper\ndescription: self evolved\n---\n\nevolved body\n',
      'utf8',
    );

    const registry = await import('../../../src/main/model/core-agent/skill-registry');
    const ownerBlock = await registry.getSystemPromptBlock({ agentId: 'custom-writer' });
    expect(ownerBlock).toContain('**draft-helper**');
    expect(ownerBlock).not.toContain('**evolved-helper**');
    expect((await registry.listSkillSpecs({ forAgentId: 'custom-writer' })).some((s) => s.id === 'draft-helper')).toBe(true);

    const commanderBlock = await registry.getSystemPromptBlock();
    expect(commanderBlock).not.toContain('**draft-helper**');
    expect(commanderBlock).not.toContain('**evolved-helper**');
  });
});
