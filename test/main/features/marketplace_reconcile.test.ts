import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { MAX_MARKETPLACE_BUNDLE_BYTES } from '../../../src/main/features/marketplace_bundle';

const postJsonMock = vi.hoisted(() => vi.fn());
const extractBundleSafelyMock = vi.hoisted(() => vi.fn());
const devtoolsMock = vi.hoisted(() => ({ isDev: false }));
const electronMock = vi.hoisted(() => ({ appVersion: '1.5.1' }));

vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: postJsonMock,
  extractBundleSafely: extractBundleSafelyMock,
}));
vi.mock('../../../src/main/features/devtools', () => ({
  isDevEnv: () => devtoolsMock.isDev,
}));
vi.mock('electron', () => ({
  app: { getVersion: () => electronMock.appVersion },
}));

let tmpDir: string;
let prevWs: string | undefined;
let server: http.Server | null = null;

function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') reject(new Error('bad test server address'));
      else resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-reconcile-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  postJsonMock.mockReset();
  extractBundleSafelyMock.mockReset();
  extractBundleSafelyMock.mockImplementation((zip: AdmZip, dst: string) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const out = path.join(dst, entry.entryName);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, entry.getData());
    }
  });
  devtoolsMock.isDev = false;
  electronMock.appVersion = '1.5.1';
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketplace reconcile', () => {
  function writeLocalSkill(id: string, meta: Record<string, unknown>): string {
    const dir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: local-skill\n---\n', 'utf8');
    fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify(meta, null, 2), 'utf8');
    return dir;
  }

  function writeLocalAgent(id: string, meta: Record<string, unknown>): string {
    const dir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ agent_id: id, name: 'Local Agent' }), 'utf8');
    fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify(meta, null, 2), 'utf8');
    return dir;
  }

  function writeResourceManifest(dir: string, resourceHash: string, onlineHash: string): void {
    fs.writeFileSync(path.join(dir, '_resource_manifest.json'), JSON.stringify({
      schemaVersion: 1,
      hashAlgorithm: 'sha256-tree-v1',
      kind: 'agent',
      id: path.basename(dir),
      resource_hash: resourceHash,
      resource_online_hash: onlineHash,
      files: ['agent.json'],
    }, null, 2), 'utf8');
  }

  function writeManifest(data: Record<string, unknown>): void {
    const dir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installs.json'), JSON.stringify(data, null, 2), 'utf8');
  }

  it('marks an installed item stale when updated_at changes even if version and published_at do not', async () => {
    postJsonMock.mockImplementation(async (p: string) => {
      if (p === '/marketplace/agents/list') {
        return {
          list: [{
            id: 'agent1',
            version: '1.0.0',
            published_at: 100,
            updated_at: 200,
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/skills/list') return { list: [], total: 0 };
      throw new Error(`unexpected path ${p}`);
    });

    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: 'agent1',
      version: '1.0.0',
      published_at: 100,
      agent_json_url: 'https://example.test/agent.json',
      create_uid: '0',
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.checkServerUpdatesForInstalls('u1');

    expect(result).toEqual({ updated_agents: 1, updated_skills: 0 });
    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(postJsonMock).toHaveBeenCalledWith('/marketplace/agents/list', {
      page: 1,
      size: 100,
      ids: ['agent1'],
    });
    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents[0]).toMatchObject({
      id: 'agent1',
      version: '1.0.0',
      published_at: 100,
      updated_at: 200,
      agent_json_url: 'https://example.test/agent.json',
    });
  });

  it('marks an installed agent stale when its private skills bundle url changes', async () => {
    postJsonMock.mockImplementation(async (p: string) => {
      if (p === '/marketplace/agents/list') {
        return {
          list: [{
            id: 'agent-private',
            version: '1.0.0',
            published_at: 100,
            updated_at: 100,
            agent_skills_bundle_url: 'https://example.test/private-v2.zip',
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/skills/list') return { list: [], total: 0 };
      throw new Error(`unexpected path ${p}`);
    });

    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: 'agent-private',
      version: '1.0.0',
      published_at: 100,
      updated_at: 100,
      agent_json_url: 'https://example.test/agent.json',
      agent_skills_bundle_url: 'https://example.test/private-v1.zip',
      create_uid: '0',
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.checkServerUpdatesForInstalls('u1');

    expect(result).toEqual({ updated_agents: 1, updated_skills: 0 });
    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents[0]).toMatchObject({
      id: 'agent-private',
      agent_skills_bundle_url: 'https://example.test/private-v2.zip',
    });
  });

  it('skips the network-heavy server catalog check during a fresh startup interval', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: 'agent-ready',
      version: '1.0.0',
      published_at: 100,
      agent_json_url: 'https://example.test/agent.json',
      create_uid: '0',
    });

    const paths = await import('../../../src/main/paths');
    const stateFile = paths.marketplaceReconcileStateFile('u1');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ server_check_attempted_at: Date.now() }), 'utf8');

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.checkServerUpdatesForInstalls('u1', { minIntervalMs: 60_000 });

    expect(result).toEqual({ updated_agents: 0, updated_skills: 0, skipped: true });
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it('checks server updates with installed ids instead of scanning every review status', async () => {
    postJsonMock.mockImplementation(async (p: string) => {
      if (p === '/marketplace/agents/list') {
        return {
          list: [{
            id: 'agent-a',
            version: '1.0.0',
            published_at: 100,
            updated_at: 100,
            status: 'approved',
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/skills/list') {
        return {
          list: [{
            id: 'skill-a',
            version: '1.0.0',
            published_at: 200,
            updated_at: 200,
            status: 'approved',
          }],
          total: 1,
        };
      }
      throw new Error(`unexpected path ${p}`);
    });
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: 'agent-a',
      version: '1.0.0',
      published_at: 100,
      updated_at: 100,
      agent_json_url: 'https://example.test/agent-a.json',
      create_uid: '0',
      status: 'approved',
    });
    await installs.addSkillInstall('u1', {
      id: 'skill-a',
      version: '1.0.0',
      published_at: 200,
      updated_at: 200,
      bundle_url: 'https://example.test/skill-a.zip',
      create_uid: '0',
      status: 'approved',
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.checkServerUpdatesForInstalls('u1');

    expect(result).toEqual({ updated_agents: 0, updated_skills: 0 });
    expect(postJsonMock).toHaveBeenCalledTimes(2);
    expect(postJsonMock).toHaveBeenNthCalledWith(1, '/marketplace/agents/list', {
      page: 1,
      size: 100,
      ids: ['agent-a'],
    });
    expect(postJsonMock).toHaveBeenNthCalledWith(2, '/marketplace/skills/list', {
      page: 1,
      size: 100,
      ids: ['skill-a'],
    });
  });

  it('restores a local-only new skill install into the cloud manifest', async () => {
    writeLocalSkill('skill-local', {
      version: '1.0.0',
      published_at: 100,
      updated_at: 100,
      bundle_url: 'https://example.test/skill.zip',
      installed_at: 300,
      create_uid: '0',
      status: 'approved',
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.restored_skills).toBe(1);
    const installs = await import('../../../src/main/features/marketplace_installs');
    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: 'skill-local',
        bundle_url: 'https://example.test/skill.zip',
        installed_at: 300,
        status: 'approved',
      }),
    ]);
  });

  it('does not auto-pull agent or skill installs when their minimum is declared but the PC version is missing', async () => {
    electronMock.appVersion = '';
    writeManifest({
      version: 1,
      agents: [{
        id: 'reconcile-version-agent',
        version: '1.0.0',
        min_app_version: '1.0.0',
        published_at: 100,
        agent_json_url: 'https://example.test/reconcile-version-agent.json',
      }],
      skills: [{
        id: 'reconcile-version-skill',
        version: '1.0.0',
        min_app_version: '1.0.0',
        published_at: 200,
        bundle_url: 'https://example.test/reconcile-version-skill.zip',
      }],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    await expect(reconcile.reconcileInstalls('u1')).resolves.toMatchObject({
      pulled_agents: 0,
      pulled_skills: 0,
      failed: [],
    });
    expect(extractBundleSafelyMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', 'reconcile-version-agent'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'reconcile-version-skill'))).toBe(false);
  });

  it('prunes a local-only skill when a newer manifest tombstone exists', async () => {
    const now = Date.now();
    const dir = writeLocalSkill('skill-deleted', {
      version: '1.0.0',
      published_at: 100,
      bundle_url: 'https://example.test/skill.zip',
      installed_at: now - 1000,
    });
    writeManifest({
      version: 1,
      agents: [],
      skills: [],
      _deleted_at: { skills: { 'skill-deleted': now } },
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.pruned_skills).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('patches local install metadata from the manifest without re-downloading content', async () => {
    writeLocalSkill('skill-meta', {
      version: '1.0.0',
      published_at: 100,
      updated_at: 100,
      bundle_url: 'https://example.test/skill.zip',
      installed_at: 300,
      create_uid: '0',
    });
    writeManifest({
      version: 1,
      agents: [],
      skills: [{
        id: 'skill-meta',
        version: '1.0.0',
        published_at: 100,
        updated_at: 100,
        bundle_url: 'https://example.test/skill.zip',
        installed_at: 300,
        create_uid: '0',
        status: 'approved',
      }],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.patched_skills).toBe(1);
    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'skill-meta', '_install.json'), 'utf8'));
    expect(meta.status).toBe('approved');
  });

  it('still re-pulls a dev Resource agent after the Resource hash matches the online baseline', async () => {
    devtoolsMock.isDev = true;
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ agent_id: 'agent-resource', name: 'Server Agent' }));
    });
    const dir = writeLocalAgent('agent-resource', {
      version: '1.0.0',
      published_at: 100,
      updated_at: 100,
      agent_json_url: `${base}/agent.json`,
      installed_at: 300,
      create_uid: '0',
    });
    writeResourceManifest(dir, 'online-prod-hash', 'online-prod-hash');
    writeManifest({
      version: 1,
      agents: [{
        id: 'agent-resource',
        version: '1.1.0',
        published_at: 100,
        updated_at: 200,
        agent_json_url: `${base}/agent.json`,
        installed_at: 300,
      }],
      skills: [],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.pulled_agents).toBe(1);
    const pulled = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8'));
    expect(pulled.name).toBe('Server Agent');
    expect(fs.existsSync(path.join(dir, '_resource_manifest.json'))).toBe(false);
  });

  it('does not write pulled content when the login guard is cancelled mid-run', async () => {
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ agent_id: 'agent-cancelled', name: 'Cancelled' }));
    });
    writeManifest({
      version: 1,
      agents: [{
        id: 'agent-cancelled',
        version: '1.0.0',
        published_at: 100,
        agent_json_url: `${base}/agent.json`,
        installed_at: 200,
      }],
      skills: [],
    });

    let guardChecks = 0;
    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1', {
      shouldContinue: () => ++guardChecks <= 5,
    }) as any;

    expect(result.failed).toEqual([]);
    expect(result.pulled_agents).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', 'agent-cancelled', 'agent.json'))).toBe(false);
  });

  it('emits reconcile progress split by item kind', async () => {
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ agent_id: 'agent-status', name: 'Status' }));
    });
    writeManifest({
      version: 1,
      agents: [{
        id: 'agent-status',
        version: '1.0.0',
        published_at: 100,
        agent_json_url: `${base}/agent.json`,
        installed_at: 200,
      }],
      skills: [],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const statuses: any[] = [];
    const unsub = reconcile.subscribeReconcileStatus((s) => statuses.push({ ...s }));
    try {
      const result = await reconcile.reconcileInstalls('u1') as any;
      expect(result.pulled_agents).toBe(1);
    } finally {
      unsub();
    }

    expect(statuses).toContainEqual(expect.objectContaining({
      state: 'running',
      total: 1,
      total_agents: 1,
      total_skills: 0,
      pulled_agents: 0,
      pulled_skills: 0,
    }));
    expect(statuses).toContainEqual(expect.objectContaining({
      state: 'done',
      total: 1,
      total_agents: 1,
      total_skills: 0,
      pulled: 1,
      pulled_agents: 1,
      pulled_skills: 0,
    }));
  });

  it('pulls marketplace agent private skills listed in the install manifest', async () => {
    const privateZip = new AdmZip();
    privateZip.addFile('private-helper/SKILL.md', Buffer.from('---\nname: private-helper\n---\n'));
    const base = await listen((req, res) => {
      if (req.url === '/agent.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          agent_id: 'agent-private',
          name: 'Private Agent',
          skill_list: ['private-helper'],
        }));
        return;
      }
      if (req.url === '/agent-skills.zip') {
        res.setHeader('Content-Type', 'application/zip');
        res.end(privateZip.toBuffer());
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    writeManifest({
      version: 1,
      agents: [{
        id: 'agent-private',
        version: '1.0.0',
        published_at: 100,
        updated_at: 100,
        agent_json_url: `${base}/agent.json`,
        agent_skills_bundle_url: `${base}/agent-skills.zip`,
        installed_at: 200,
      }],
      skills: [],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const paths = await import('../../../src/main/paths');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.pulled_agents).toBe(1);
    expect(extractBundleSafelyMock).toHaveBeenCalledWith(
      expect.anything(),
      paths.userMarketplaceAgentSkillsDir('u1', 'agent-private'),
    );
  });

  it('rejects an oversized skill bundle before reconcile parses or extracts it', async () => {
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(MAX_MARKETPLACE_BUNDLE_BYTES + 1));
      res.end('oversized');
    });
    writeManifest({
      version: 1,
      agents: [],
      skills: [{
        id: 'oversized-skill',
        version: '1.0.0',
        published_at: 100,
        bundle_url: `${base}/skill.zip`,
        installed_at: 200,
      }],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1');

    expect(result).toMatchObject({ pulled_skills: 0, failed: ['skill:oversized-skill'] });
    expect(extractBundleSafelyMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'oversized-skill'))).toBe(false);
  });

  it('cancels a streaming skill bundle when reconcile admission is revoked', async () => {
    const skillZip = new AdmZip();
    skillZip.addFile('SKILL.md', Buffer.from('---\nname: cancelled-skill\n---\n'));
    const body = skillZip.toBuffer();
    let shouldContinue = true;
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/zip');
      res.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
      shouldContinue = false;
      setTimeout(() => res.end(body.subarray(Math.max(1, Math.floor(body.length / 2)))), 10);
    });
    writeManifest({
      version: 1,
      agents: [],
      skills: [{
        id: 'cancelled-skill',
        version: '1.0.0',
        published_at: 100,
        bundle_url: `${base}/skill.zip`,
        installed_at: 200,
      }],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1', { shouldContinue: () => shouldContinue });

    expect(result).toMatchObject({ pulled_skills: 0, failed: [] });
    expect(extractBundleSafelyMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'cancelled-skill'))).toBe(false);
  });

  it('pulls new skill_list dependencies while reconciling an updated agent', async () => {
    const depZip = new AdmZip();
    depZip.addFile('SKILL.md', Buffer.from('---\nname: dep-skill\n---\n'));
    const base = await listen((req, res) => {
      if (req.url === '/agent.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          agent_id: 'agent-updated',
          name: 'Updated Agent',
          skill_list: ['dep-skill'],
        }));
        return;
      }
      if (req.url === '/dep-skill.zip') {
        res.setHeader('Content-Type', 'application/zip');
        res.end(depZip.toBuffer());
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    postJsonMock.mockImplementation(async (p: string, body: any) => {
      if (p === '/marketplace/skills/bundle' && body?.id === 'dep-skill') {
        return {
          bundle_url: `${base}/dep-skill.zip`,
          version: '1.0.0',
          published_at: 100,
          updated_at: 110,
          create_uid: '0',
          status: 'approved',
        };
      }
      throw new Error(`unexpected path ${p}`);
    });
    writeManifest({
      version: 1,
      agents: [{
        id: 'agent-updated',
        version: '2.0.0',
        published_at: 100,
        updated_at: 200,
        agent_json_url: `${base}/agent.json`,
        installed_at: 300,
      }],
      skills: [],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const installs = await import('../../../src/main/features/marketplace_installs');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.pulled_agents).toBe(1);
    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: 'dep-skill',
        bundle_url: `${base}/dep-skill.zip`,
        status: 'approved',
      }),
    ]);
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'dep-skill', 'SKILL.md'))).toBe(true);
    const agentJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', 'agent-updated', 'agent.json'), 'utf8'));
    expect(agentJson.skill_list).toEqual(['dep-skill']);
  });

  it('emits a visible status while default installs are being seeded', async () => {
    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const statuses: any[] = [];
    const unsub = reconcile.subscribeReconcileStatus((s) => statuses.push({ ...s }));
    try {
      reconcile.setDefaultInstallSeedStatus(true);
      reconcile.setDefaultInstallSeedStatus(false);
    } finally {
      unsub();
    }

    expect(statuses).toContainEqual(expect.objectContaining({
      state: 'running',
      phase: 'default_seed',
      total_agents: 1,
      total_skills: 1,
    }));
    expect(statuses.at(-1)).toMatchObject({ state: 'idle' });
  });
});
