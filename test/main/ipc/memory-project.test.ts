import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-memory-ipc';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-memory-project-ipc-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupProject(name: string) {
  const projects = await import('../../../src/main/features/projects');
  const result = await projects.createProject(UID, name);
  if (!result.ok) throw new Error(`create project failed: ${result.error}`);
  return result.project.project_id;
}

async function setupAgent(name: string, cli?: 'codex' | 'opencode') {
  const agents = await import('../../../src/main/features/agents');
  const agent = await agents.createCustomAgent({
    name,
    description: `${name} test agent`,
    ...(cli ? { runtime: { kind: 'cli' as const, cli } } : {}),
  });
  if (!agent) throw new Error('create agent failed');
  return agent.agent_id;
}

async function call(
  channel: 'memory.list' | 'memory.add' | 'memory.replace' | 'memory.remove' | 'memory.reveal',
  payload: any,
  userId = UID,
) {
  const { invokeHandlers } = await import('../../../src/main/ipc/memory');
  return invokeHandlers[channel](payload, { userId });
}

describe('ipc/memory project scope', () => {
  it('round-trips add, list, replace, and remove within the authorized project', async () => {
    const pid = await setupProject('Alpha');
    const scope = { target: 'project', projectId: pid };

    expect(await call('memory.add', { ...scope, content: 'Checkout uses Stripe.' })).toMatchObject({
      ok: true,
      entries: ['Checkout uses Stripe.'],
    });
    expect(await call('memory.list', scope)).toMatchObject({ entries: ['Checkout uses Stripe.'] });
    expect(await call('memory.replace', {
      ...scope,
      oldText: 'Checkout uses Stripe.',
      content: 'Checkout uses Adyen.',
    })).toMatchObject({ ok: true, entries: ['Checkout uses Adyen.'] });
    expect(await call('memory.remove', { ...scope, oldText: 'Checkout uses Adyen.' })).toMatchObject({
      ok: true,
      entries: [],
    });
  });

  it('keeps project memories isolated from other projects and users', async () => {
    const first = await setupProject('First');
    const second = await setupProject('Second');
    await call('memory.add', { target: 'project', projectId: first, content: 'first-only' });

    expect(await call('memory.list', { target: 'project', projectId: second })).toMatchObject({ entries: [] });
    await expect(call('memory.list', { target: 'project', projectId: first }, 'another-user'))
      .rejects.toThrow('project_not_found');
  });

  it('rejects missing, unknown, and traversal project ids without creating orphan storage', async () => {
    await expect(call('memory.list', { target: 'project' })).rejects.toThrow(/projectId is required/);
    await expect(call('memory.add', {
      target: 'project',
      projectId: 'p_ffffffffffff',
      content: 'must not persist',
    })).rejects.toThrow('project_not_found');
    await expect(call('memory.reveal', {
      target: 'project',
      projectId: 'p_ffffffffffff',
    })).rejects.toThrow('project_not_found');
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'projects', 'p_ffffffffffff'))).toBe(false);
    await expect(call('memory.list', { target: 'project', projectId: '../escape' }))
      .rejects.toThrow(/invalid project id/);
  });
});

describe('ipc/memory Agent scope', () => {
  it('keeps the synthetic Commander memory scope available without an agent.json', async () => {
    const scope = { target: 'agent', agentId: 'commander' };
    expect(await call('memory.add', { ...scope, content: 'Commander-only convention' }))
      .toMatchObject({ ok: true, entries: ['Commander-only convention'] });
    expect(await call('memory.list', scope))
      .toMatchObject({ ok: true, entries: ['Commander-only convention'] });
  });

  it.each([
    ['in-process', undefined],
    ['Codex', 'codex'],
  ] as const)('allows %s Agent memory through the generic scoped API', async (name, cli) => {
    const agentId = await setupAgent(`${name}-memory`, cli);
    const scope = { target: 'agent', agentId };

    expect(await call('memory.add', { ...scope, content: 'stable Agent convention' }))
      .toMatchObject({ ok: true, entries: ['stable Agent convention'] });
    expect(await call('memory.list', scope))
      .toMatchObject({ ok: true, entries: ['stable Agent convention'] });
  });

  it('rejects unsupported CLI Agent access without deleting its preserved memory file', async () => {
    const agentId = await setupAgent('OpenCode-memory-boundary', 'opencode');
    const memory = await import('../../../src/main/features/memory');
    expect(memory.addAgentEntry(UID, agentId, 'preserved historical entry').ok).toBe(true);
    const scope = { target: 'agent', agentId };

    await expect(call('memory.list', scope)).rejects.toThrow(
      'agent memory is supported only for Claude and Codex CLI agents',
    );
    await expect(call('memory.add', { ...scope, content: 'must not persist' })).rejects.toThrow(
      'agent memory is supported only for Claude and Codex CLI agents',
    );
    expect(memory.listAgentEntries(UID, agentId).entries).toEqual(['preserved historical entry']);
  });

  it('rejects an unknown Agent id without creating orphan memory storage', async () => {
    const agentId = 'a00000000000';
    await expect(call('memory.add', {
      target: 'agent', agentId, content: 'must not persist',
    })).rejects.toThrow('agent_not_found');
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'memory', 'agents', agentId))).toBe(false);
  });
});
