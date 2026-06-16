import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
let prevApi: string | undefined;
let prevProfile: string | undefined;
let server: http.Server | null = null;

function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') reject(new Error('bad test server address'));
      else resolve(`http://127.0.0.1:${addr.port}/api`);
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-defaults-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevApi = process.env.ORKAS_API_BASE_URL;
  prevProfile = process.env.ORKAS_PROFILE;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevApi === undefined) delete process.env.ORKAS_API_BASE_URL;
  else process.env.ORKAS_API_BASE_URL = prevApi;
  if (prevProfile === undefined) delete process.env.ORKAS_PROFILE;
  else process.env.ORKAS_PROFILE = prevProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketplace default installs', () => {
  it('uses bare production API domains so POST requests are not downgraded by www redirects', async () => {
    delete process.env.ORKAS_API_BASE_URL;

    process.env.ORKAS_PROFILE = 'global';
    vi.resetModules();
    let marketplace = await import('../../../src/main/features/marketplace');
    expect(marketplace.apiBase()).toBe('https://orkas.ai/api');

    process.env.ORKAS_PROFILE = 'cn';
    vi.resetModules();
    marketplace = await import('../../../src/main/features/marketplace');
    expect(marketplace.apiBase()).toBe('https://orkas.work/api');
  });

  it('canonicalizes www API env overrides before marketplace POST requests', async () => {
    process.env.ORKAS_API_BASE_URL = `https://${'www.'}orkas.ai/api/`;
    vi.resetModules();

    const marketplace = await import('../../../src/main/features/marketplace');

    expect(marketplace.apiBase()).toBe('https://orkas.ai/api');
  });

  it('does not report an id as the marketplace install display name', async () => {
    const marketplace = await import('../../../src/main/features/marketplace');

    const unnamed = new marketplace.MarketplaceInstallError('skill', 'skill-id-123', undefined, 'Not found');
    expect(marketplace.getMarketplaceInstallErrorInfo(unnamed)).toMatchObject({
      kind: 'skill',
      id: 'skill-id-123',
      name: '',
      reason: 'Not found',
    });

    const named = new marketplace.MarketplaceInstallError('skill', 'skill-id-123', 'Writer', 'Not found');
    expect(marketplace.getMarketplaceInstallErrorInfo(named)).toMatchObject({
      name: 'Writer',
    });
  });

  it('installs legacy marketplace skills when only _meta category advisories are present', async () => {
    process.env.ORKAS_API_BASE_URL = await listen((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/marketplace/skills/bundle');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        code: 0,
        bundle_url: 'https://cdn.test/legacy-skill.zip',
        version: '1.0.0',
        published_at: 10,
        create_uid: '0',
        status: 'approved',
      }));
    });

    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const cache = await import('../../../src/main/features/marketplace_cache');
    await cache.writeSkillCache('legacy-skill', (dir) => {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: legacy-skill\ndescription: Legacy skill\n---\n', 'utf8');
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'parse_outline.py'), [
        'message = (',
        '    f"预估总节点 {estimated_total_nodes} > 100(SKILL.md 核心原则 9); "',
        '    "建议 LLM 先压缩大纲"',
        ')',
      ].join('\n'), 'utf8');
    }, { version: '1.0.0', published_at: 10 });

    const marketplace = await import('../../../src/main/features/marketplace');
    const paths = await import('../../../src/main/paths');
    const reports = await import('../../../src/main/quality/report');

    await expect(marketplace.installMarketplaceSkill('legacy-skill', {
      version: '1.0.0',
      published_at: 10,
    })).resolves.toEqual({ ok: true, id: 'legacy-skill' });

    const target = paths.userMarketplaceSkillDir('u1', 'legacy-skill');
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(true);
    const report = await reports.readReport({ uid: 'u1', kind: 'skill', id: 'legacy-skill' });
    expect(report?.ok).toBe(true);
    expect(report?.violations.map((v) => v.rule)).toContain('skill_meta_category_missing');
    expect(report?.violations.map((v) => v.rule)).not.toContain('no_spec_self_modification');
  });

  it('returns only blocking quality findings in marketplace install rejection details', async () => {
    process.env.ORKAS_API_BASE_URL = await listen((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/marketplace/skills/bundle');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        code: 0,
        bundle_url: 'https://cdn.test/unsafe-skill.zip',
        version: '1.0.0',
        published_at: 10,
        create_uid: '0',
        status: 'approved',
      }));
    });

    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const cache = await import('../../../src/main/features/marketplace_cache');
    await cache.writeSkillCache('unsafe-skill', (dir) => {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: unsafe-skill\ndescription: Unsafe skill\n---\n', 'utf8');
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'x.sh'), 'echo "name: hacked" > SKILL.md\n', 'utf8');
    }, { version: '1.0.0', published_at: 10 });

    const marketplace = await import('../../../src/main/features/marketplace');

    let thrown: unknown = null;
    try {
      await marketplace.installMarketplaceSkill('unsafe-skill', {
        version: '1.0.0',
        published_at: 10,
      });
    } catch (err) {
      thrown = err;
    }

    const info = marketplace.getMarketplaceInstallErrorInfo(thrown);
    expect(info.reason).toMatch(/^Quality validation rejected skill unsafe-skill/);
    expect(info.qualityReport?.ok).toBe(false);
    expect(info.qualityReport?.violations.map((v) => v.rule)).toEqual(['no_spec_self_modification']);
  });

  it('does not show default-install work when marked defaults are already local', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: 'agent-ready',
      version: '1.0.0',
      published_at: 10,
      agent_json_url: 'https://cdn.test/agent-ready.json',
      default_install: true,
    });
    await installs.addSkillInstall('u1', {
      id: 'skill-ready',
      version: '1.0.0',
      published_at: 20,
      bundle_url: 'https://cdn.test/skill-ready.zip',
      default_install: true,
    });
    fs.mkdirSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', 'agent-ready'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', 'agent-ready', 'agent.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'skill-ready'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'skill-ready', 'SKILL.md'), '---\nname: Ready\n---\n', 'utf8');
    const markerDir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, '.default-seeded.json'), JSON.stringify({
      seeded_at: 1,
      version: 1,
      agent_ids: ['agent-ready'],
      skill_ids: ['skill-ready'],
    }), 'utf8');

    const marketplace = await import('../../../src/main/features/marketplace');

    await expect(marketplace.hasKnownDefaultInstallWork('u1')).resolves.toBe(false);
  });

  it('skips the defaults endpoint when recent defaults are already local', async () => {
    let calls = 0;
    process.env.ORKAS_API_BASE_URL = await listen((_req, res) => {
      calls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, agents: [], skills: [] }));
    });

    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: 'agent-ready',
      version: '1.0.0',
      published_at: 10,
      agent_json_url: 'https://cdn.test/agent-ready.json',
      default_install: true,
    });
    await installs.addSkillInstall('u1', {
      id: 'skill-ready',
      version: '1.0.0',
      published_at: 20,
      bundle_url: 'https://cdn.test/skill-ready.zip',
      default_install: true,
    });
    fs.mkdirSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', 'agent-ready'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', 'agent-ready', 'agent.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'skill-ready'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'skill-ready', 'SKILL.md'), '---\nname: Ready\n---\n', 'utf8');
    const markerDir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, '.default-seeded.json'), JSON.stringify({
      seeded_at: Date.now(),
      checked_at: Date.now(),
      version: 1,
      agent_ids: ['agent-ready'],
      skill_ids: ['skill-ready'],
    }), 'utf8');

    const marketplace = await import('../../../src/main/features/marketplace');

    await expect(marketplace.ensureDefaultInstalls('u1', { minIntervalMs: 60_000 })).resolves.toEqual({
      seeded_agents: 0,
      seeded_skills: 0,
      skipped: true,
    });
    expect(calls).toBe(0);
  });

  it('shows default-install work for a fresh logged-in account', async () => {
    const marketplace = await import('../../../src/main/features/marketplace');

    await expect(marketplace.hasKnownDefaultInstallWork('u1')).resolves.toBe(true);
  });

  it('does not seed defaults for the logged-out anonymous user', async () => {
    let calls = 0;
    process.env.ORKAS_API_BASE_URL = await listen((_req, res) => {
      calls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, agents: [], skills: [] }));
    });

    const users = await import('../../../src/main/features/users');
    const marketplace = await import('../../../src/main/features/marketplace');

    await expect(marketplace.ensureDefaultInstalls(users.ANONYMOUS_LOCAL_ID)).resolves.toEqual({
      seeded_agents: 0,
      seeded_skills: 0,
    });
    expect(calls).toBe(0);
  });

  it('reports transient default seed failures so logged-in startup can retry', async () => {
    let calls = 0;
    process.env.ORKAS_API_BASE_URL = await listen((req, res) => {
      calls++;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/marketplace/defaults');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 1, msg: '系统繁忙，请稍后重试' }));
    });

    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const marketplace = await import('../../../src/main/features/marketplace');
    await expect(marketplace.ensureDefaultInstalls('u1')).resolves.toMatchObject({
      seeded_agents: 0,
      seeded_skills: 0,
      failed: true,
      error: '系统繁忙，请稍后重试',
    });
    expect(calls).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'cloud', 'marketplace', '.default-seeded.json'))).toBe(false);
  });

  it('incrementally seeds new defaults while respecting installed rows and uninstall tombstones', async () => {
    process.env.ORKAS_API_BASE_URL = await listen((req, res) => {
      if (req.method === 'POST' && req.url === '/api/marketplace/defaults') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          code: 0,
          agents: [{
            id: 'agent-new',
            version: '1.0.0',
            published_at: 10,
            updated_at: 20,
            agent_json_url: 'https://cdn.test/agent-new.json',
            create_uid: '0',
            status: 'approved',
          }, {
            id: 'agent-blocked',
            version: '1.0.0',
            published_at: 11,
            updated_at: 21,
            agent_json_url: 'https://cdn.test/agent-blocked.json',
            create_uid: '0',
            status: 'approved',
          }, {
            id: 'agent-failing',
            version: '1.0.0',
            published_at: 12,
            updated_at: 22,
            agent_json_url: 'https://cdn.test/agent-failing.json',
            create_uid: '0',
            status: 'approved',
          }, {
            id: 'agent-after-failure',
            version: '1.0.0',
            published_at: 13,
            updated_at: 23,
            agent_json_url: 'https://cdn.test/agent-after-failure.json',
            create_uid: '0',
            status: 'approved',
          }],
          skills: [
            {
              id: 'skill-installed',
              version: '1.0.0',
              published_at: 30,
              bundle_url: 'https://cdn.test/skill-installed.zip',
              create_uid: '0',
              status: 'approved',
            },
            {
              id: 'skill-deleted',
              version: '1.0.0',
              published_at: 40,
              bundle_url: 'https://cdn.test/skill-deleted.zip',
              create_uid: '0',
              status: 'approved',
            },
            {
              id: 'skill-new',
              version: '1.0.0',
              published_at: 50,
              updated_at: 60,
              bundle_url: 'https://cdn.test/skill-new.zip',
              create_uid: '0',
              status: 'approved',
            },
          ],
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/marketplace/agents/detail') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          const body = JSON.parse(raw || '{}');
          res.setHeader('Content-Type', 'application/json');
          if (body.id === 'agent-failing') {
            res.end(JSON.stringify({ code: 1, msg: 'temporary detail failure' }));
            return;
          }
          res.end(JSON.stringify({
            code: 0,
            agent_json: {
              name: body.id,
              skill_list: body.id === 'agent-blocked' ? ['skill-deleted'] : ['skill-dep'],
            },
            version: '1.0.0',
            category: 'general',
            published_at: 10,
            agent_json_url: `https://cdn.test/${body.id}.json`,
            create_uid: '0',
            status: 'approved',
          }));
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/marketplace/skills/bundle') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          const body = JSON.parse(raw || '{}');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            code: 0,
            bundle_url: `https://cdn.test/${body.id}.zip`,
            version: '1.0.0',
            published_at: 70,
            updated_at: 80,
            create_uid: '0',
            status: 'approved',
            default_install: false,
          }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addSkillInstall('u1', {
      id: 'skill-installed',
      version: '1.0.0',
      published_at: 30,
      bundle_url: 'https://cdn.test/skill-installed.zip',
    });
    await installs.addSkillInstall('u1', {
      id: 'skill-deleted',
      version: '1.0.0',
      published_at: 40,
      bundle_url: 'https://cdn.test/skill-deleted.zip',
    });
    await installs.removeSkillInstall('u1', 'skill-deleted');

    const markerDir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, '.default-seeded.json'), JSON.stringify({
      seeded_at: 1,
      version: 1,
      agent_ids: [],
      skill_ids: ['skill-installed', 'skill-deleted'],
    }), 'utf8');

    const marketplace = await import('../../../src/main/features/marketplace');
    await expect(marketplace.ensureDefaultInstalls('u1')).resolves.toEqual({
      seeded_agents: 2,
      seeded_skills: 2,
    });

    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents.map((a) => a.id)).toEqual(['agent-new', 'agent-after-failure']);
    expect(manifest.skills.map((s) => s.id).sort()).toEqual(['skill-dep', 'skill-installed', 'skill-new']);
    expect(manifest._deleted_at?.skills?.['skill-deleted']).toEqual(expect.any(Number));
    expect(manifest.skills.find((s) => s.id === 'skill-deleted')).toBeUndefined();
    expect(manifest.agents.find((a) => a.id === 'agent-blocked')).toBeUndefined();
    expect(manifest.agents.find((a) => a.id === 'agent-failing')).toBeUndefined();

    const marker = JSON.parse(fs.readFileSync(path.join(markerDir, '.default-seeded.json'), 'utf8'));
    expect(marker.agent_ids).toEqual(['agent-new', 'agent-blocked', 'agent-failing', 'agent-after-failure']);
    expect(marker.skill_ids).toEqual(['skill-installed', 'skill-deleted', 'skill-new']);
  });

});
