import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agent: null as any,
  entries: [] as any[],
  projectDir: null as any,
  detectAll: vi.fn(),
  getAgent: vi.fn(),
  getProjectDir: vi.fn(),
  getRuntimeOptions: vi.fn(),
  getResolvedModel: vi.fn(),
}));

vi.mock('../../../src/main/features/agents', () => ({
  isValidAgentId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id),
  getAgent: (...args: unknown[]) => mocks.getAgent(...args),
  getAgentCliProjectDirInfo: (...args: unknown[]) => mocks.getProjectDir(...args),
  getAgentCliResolvedModelInfo: (...args: unknown[]) => mocks.getResolvedModel(...args),
}));

vi.mock('../../../src/main/features/local_agents/registry', () => ({
  LOCAL_CLI_TYPES: ['claude', 'codex', 'openclaw', 'opencode', 'hermes'],
  detectAll: (...args: unknown[]) => mocks.detectAll(...args),
  detectOne: vi.fn(),
  findAllInstalled: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock('../../../src/main/features/local_agents/runtime_options', () => ({
  getLocalCliRuntimeOptions: (...args: unknown[]) => mocks.getRuntimeOptions(...args),
}));

import { invokeHandlers } from '../../../src/main/ipc/local_agents';

type RuntimeOptionsHandler = (
  payload: Record<string, unknown>,
  ctx: { userId: string },
) => Promise<any>;

const handler = invokeHandlers['localAgents.runtimeOptions'] as RuntimeOptionsHandler;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent = null;
  mocks.entries = [];
  mocks.projectDir = null;
  mocks.detectAll.mockImplementation(async () => mocks.entries);
  mocks.getAgent.mockImplementation(async () => mocks.agent);
  mocks.getProjectDir.mockImplementation(async () => mocks.projectDir);
  mocks.getResolvedModel.mockReturnValue(null);
  mocks.getRuntimeOptions.mockResolvedValue({
    cli: 'codex',
    status: 'ready',
    default_model: 'gpt-default',
  });
});

describe('ipc/localAgents.runtimeOptions', () => {
  it('rejects malformed ids before discovery or Agent lookup', async () => {
    await expect(handler({ agent_id: '../agent' }, { userId: 'u1' }))
      .rejects.toThrow('invalid agent_id');
    await expect(handler({ agent_id: 42 }, { userId: 'u1' }))
      .rejects.toThrow('invalid agent_id');
    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(mocks.detectAll).not.toHaveBeenCalled();
  });

  it('rejects missing and non-CLI Agents without probing local executables', async () => {
    mocks.agent = null;
    await expect(handler({ agent_id: 'missing' }, { userId: 'u1' }))
      .rejects.toThrow('agent not found');

    mocks.agent = { agent_id: 'ordinary', runtime: { kind: 'in_process' } };
    await expect(handler({ agent_id: 'ordinary' }, { userId: 'u1' }))
      .rejects.toThrow('not backed by a supported CLI');

    mocks.agent = { agent_id: 'unknown_cli', runtime: { kind: 'cli', cli: 'unknown' } };
    await expect(handler({ agent_id: 'unknown_cli' }, { userId: 'u1' }))
      .rejects.toThrow('not backed by a supported CLI');
    expect(mocks.detectAll).not.toHaveBeenCalled();
    expect(mocks.getRuntimeOptions).not.toHaveBeenCalled();
  });

  it('derives the CLI and cwd from the Agent instead of renderer-supplied values', async () => {
    const trustedEntry = {
      type: 'codex',
      path: '/trusted/bin/codex',
      version: '99.0.0',
      available: true,
    };
    mocks.agent = { agent_id: 'agent_1', runtime: { kind: 'cli', cli: 'codex' } };
    mocks.entries = [trustedEntry];
    mocks.projectDir = { effective_path: '/trusted/project' };
    mocks.getResolvedModel.mockReturnValue({
      cli: 'codex',
      requested_model: 'gpt-default',
      resolved_model: 'gpt-default',
      updated_at: '2026-08-04T00:00:00.000Z',
    });

    await expect(handler({
      agent_id: 'agent_1',
      force: true,
      cli: 'hermes',
      cwd: '/attacker/project',
      path: '/attacker/bin',
    }, { userId: 'u1' })).resolves.toEqual({
      options: {
        cli: 'codex',
        status: 'ready',
        default_model: 'gpt-default',
        last_resolved_model: {
          cli: 'codex',
          requested_model: 'gpt-default',
          resolved_model: 'gpt-default',
          updated_at: '2026-08-04T00:00:00.000Z',
        },
      },
    });

    expect(mocks.getAgent).toHaveBeenCalledWith('agent_1');
    expect(mocks.getProjectDir).toHaveBeenCalledWith('u1', 'agent_1');
    expect(mocks.getResolvedModel).toHaveBeenCalledWith('u1', 'agent_1');
    expect(mocks.detectAll).toHaveBeenCalledWith();
    expect(mocks.getRuntimeOptions).toHaveBeenCalledWith(
      trustedEntry,
      '/trusted/project',
      { force: true },
    );
  });

  it('does not expose an observation recorded for another CLI', async () => {
    mocks.agent = { agent_id: 'agent_1', runtime: { kind: 'cli', cli: 'codex' } };
    mocks.entries = [{ type: 'codex', path: '/trusted/codex', available: true }];
    mocks.getResolvedModel.mockReturnValue({
      cli: 'claude',
      requested_model: 'sonnet',
      resolved_model: 'claude-sonnet-4-6',
      updated_at: '2026-08-04T00:00:00.000Z',
    });

    const result = await handler({ agent_id: 'agent_1' }, { userId: 'u1' });
    expect(result.options).not.toHaveProperty('last_resolved_model');
  });

  it('fails closed when the bound CLI is absent from the canonical registry result', async () => {
    mocks.agent = { agent_id: 'agent_2', runtime: { kind: 'cli', cli: 'codex' } };
    mocks.entries = [{ type: 'claude', path: '/trusted/claude', available: true }];
    mocks.projectDir = { effective_path: '/trusted/project' };

    await expect(handler({ agent_id: 'agent_2' }, { userId: 'u1' }))
      .rejects.toThrow('CLI entry not found');
    expect(mocks.getRuntimeOptions).not.toHaveBeenCalled();
  });
});
