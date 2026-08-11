import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: postJsonMock,
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevBuiltin: string | undefined;

const TEST_AGENT_ID = '222222222222';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-builtin-marketplace-startup-'));
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

function writeBuiltinAgent(id: string, agentJson: Record<string, unknown>): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'agents', id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'agent.json'), JSON.stringify({ agent_id: id, ...agentJson }, null, 2), 'utf8');
}

function writeBuiltinAgentSkill(id: string, skillId: string, description: string, body: string): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'agents', id, 'skills', skillId);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), [
    '---',
    `name: ${skillId}`,
    `description: ${description}`,
    '---',
    '',
    body,
    '',
  ].join('\n'), 'utf8');
}

describe('builtin marketplace startup seed', () => {
  it('runs for the active local user without requiring account verification', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.0.0',
      updated_at: '2026-07-08T00:00:00.000Z',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
    });

    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');
    users.activateUser('u1');

    const changed: unknown[] = [];
    await expect(startup.seedBuiltinMarketplaceForActiveUser({
      reason: 'test',
      onChanged: (result) => changed.push(result),
    })).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 1,
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'))).toBe(true);
    expect(changed).toHaveLength(1);
  });

  it('returns null when boot has not activated a user yet', async () => {
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');

    await expect(startup.seedBuiltinMarketplaceForActiveUser({ reason: 'test' })).resolves.toBeNull();
  });

  it('keeps a complete old Agent visible until an active turn releases the staged refresh', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.0.0',
      updated_at: '2026-07-08T00:00:00.000Z',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
      workflow: 'old workflow',
      skill_list: ['gate-control'],
    });
    writeBuiltinAgentSkill(TEST_AGENT_ID, 'gate-control', 'old private policy', 'old body');

    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const agents = await import('../../../src/main/features/agents');
    const registry = await import('../../../src/main/model/core-agent/skill-registry');
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');
    const runtimePublish = await import('../../../src/main/features/runtime_content_publish');
    users.activateUser('u1');
    await startup.seedBuiltinMarketplaceForActiveUser({ reason: 'initial' });

    expect((await agents.getAgent(TEST_AGENT_ID))?.workflow).toBe('old workflow');
    expect((await registry.listSkillSpecs({ forAgentId: TEST_AGENT_ID }))
      .find((skill) => skill.id === 'gate-control')?.description_en).toBe('old private policy');

    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.1.0',
      updated_at: '2026-07-09T00:00:00.000Z',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
      workflow: 'new workflow',
      skill_list: ['gate-control'],
    });
    writeBuiltinAgentSkill(TEST_AGENT_ID, 'gate-control', 'new private policy', 'new body');

    const releaseTurn = await runtimePublish.enterRuntimeContentTurn('u1');
    const backgroundRefresh = startup.seedBuiltinMarketplaceForUser('u1', { reason: 'background' });
    const queuedAt = Date.now();
    while (runtimePublish._runtimeContentPublishState('u1').queued === 0) {
      if (Date.now() - queuedAt > 1_000) throw new Error('staged refresh did not reach idle publication queue');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect((await agents.getAgent(TEST_AGENT_ID))?.workflow).toBe('old workflow');
    expect((await registry.listSkillSpecs({ forAgentId: TEST_AGENT_ID }))
      .find((skill) => skill.id === 'gate-control')?.description_en).toBe('old private policy');

    releaseTurn();
    await backgroundRefresh;

    expect((await agents.getAgent(TEST_AGENT_ID))?.workflow).toBe('new workflow');
    expect((await registry.listSkillSpecs({ forAgentId: TEST_AGENT_ID }))
      .find((skill) => skill.id === 'gate-control')?.description_en).toBe('new private policy');
    expect(fs.readFileSync(
      path.join(paths.userMarketplaceAgentSkillsDir('u1', TEST_AGENT_ID), 'gate-control', 'SKILL.md'),
      'utf8',
    )).toContain('new body');
  });

  it('deduplicates concurrent refresh triggers while publication waits for an active turn', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.0.0',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
      workflow: 'old workflow',
    });

    const users = await import('../../../src/main/features/users');
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');
    const runtimePublish = await import('../../../src/main/features/runtime_content_publish');
    users.activateUser('u1');
    await startup.seedBuiltinMarketplaceForActiveUser({ reason: 'initial' });

    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.1.0',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
      workflow: 'new workflow',
    });

    const releaseTurn = await runtimePublish.enterRuntimeContentTurn('u1');
    const first = startup.seedBuiltinMarketplaceForUser('u1', { reason: 'startup' });
    const second = startup.seedBuiltinMarketplaceForUser('u1', { reason: 'account-change' });
    const queuedAt = Date.now();
    while (runtimePublish._runtimeContentPublishState('u1').queued === 0) {
      if (Date.now() - queuedAt > 1_000) throw new Error('deduplicated refresh did not reach publish queue');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtimePublish._runtimeContentPublishState('u1').queued).toBe(1);

    releaseTurn();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ seeded_agents: 1 }),
      expect.objectContaining({ seeded_agents: 1 }),
    ]);
  });

  it('discards a staged refresh when its account context changes before publication', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.0.0',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
      workflow: 'old workflow',
    });

    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');
    const runtimePublish = await import('../../../src/main/features/runtime_content_publish');
    users.activateUser('u1');
    await startup.seedBuiltinMarketplaceForActiveUser({ reason: 'initial' });

    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.1.0',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
      workflow: 'must not publish',
    });

    let currentContext = true;
    const releaseTurn = await runtimePublish.enterRuntimeContentTurn('u1');
    const refresh = startup.seedBuiltinMarketplaceForUser('u1', {
      reason: 'account-change',
      shouldContinue: () => currentContext,
    });
    const queuedAt = Date.now();
    while (runtimePublish._runtimeContentPublishState('u1').queued === 0) {
      if (Date.now() - queuedAt > 1_000) throw new Error('cancelled refresh did not reach publish queue');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    currentContext = false;
    releaseTurn();
    await expect(refresh).rejects.toThrow(/publish context changed/);
    const installed = JSON.parse(fs.readFileSync(
      path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'),
      'utf8',
    ));
    expect(installed.workflow).toBe('old workflow');
    expect(fs.readdirSync(paths.userMarketplaceAgentsDir('u1'))
      .filter((name) => name.startsWith(`.${TEST_AGENT_ID}.install-`))).toEqual([]);
    expect(runtimePublish._runtimeContentPublishState('u1')).toEqual({
      activeTurns: 0,
      waitingTurns: 0,
      publishing: false,
      queued: 0,
    });
  });

  it('leaves the installed Agent untouched when packaged agent.json is invalid', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.0.0',
      updated_at: '2026-07-08T00:00:00.000Z',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
      workflow: 'old installed workflow',
    });

    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');
    users.activateUser('u1');
    await startup.seedBuiltinMarketplaceForActiveUser({ reason: 'initial' });

    const packagedAgentJson = path.join(
      tmpDir, 'builtin', 'marketplace', 'agents', TEST_AGENT_ID, 'agent.json',
    );
    fs.writeFileSync(packagedAgentJson, '{ invalid json', 'utf8');

    await expect(startup.seedBuiltinMarketplaceForActiveUser({ reason: 'invalid-retry' }))
      .resolves.toMatchObject({ seeded_agents: 0, manifest_agents: 0 });
    const installed = JSON.parse(fs.readFileSync(
      path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'),
      'utf8',
    ));
    expect(installed.workflow).toBe('old installed workflow');
    expect(installed.version).toBe('1.0.0');
  });
});
