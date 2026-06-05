import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

function jsonResponse(body: unknown) {
  return {
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-defaults-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.restoreAllMocks();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketplace default installs', () => {
  it('incrementally seeds new defaults while respecting installed rows and uninstall tombstones', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname === '/api/marketplace/defaults') {
        return jsonResponse({
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
        });
      }
      if (init?.method === 'POST' && url.pathname === '/api/marketplace/agents/detail') {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.id === 'agent-failing') {
          return jsonResponse({ code: 1, msg: 'temporary detail failure' });
        }
        return jsonResponse({
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
        });
      }
      if (init?.method === 'POST' && url.pathname === '/api/marketplace/skills/bundle') {
        const body = JSON.parse(String(init.body || '{}'));
        return jsonResponse({
          code: 0,
          bundle_url: `https://cdn.test/${body.id}.zip`,
          version: '1.0.0',
          published_at: 70,
          updated_at: 80,
          create_uid: '0',
          status: 'approved',
          default_install: false,
        });
      }
      return { status: 404, text: async () => 'not found' } as Response;
    });

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
