import { describe, it, expect, vi } from 'vitest';

const acpMock = vi.hoisted(() => ({
  defs: [] as any[],
}));

vi.mock('../../../../src/main/features/local_agents/backends/_acp', () => ({
  makeAcpBackend: (def: any) => {
    acpMock.defs.push(def);
    return { run: vi.fn() };
  },
}));

describe('local_agents/backends/hermes', () => {
  it('configures Hermes as an ACP backend with headless permissions enabled', async () => {
    const { hermesBackend } = await import('../../../../src/main/features/local_agents/backends/hermes');

    expect(typeof hermesBackend.run).toBe('function');
    expect(acpMock.defs).toHaveLength(1);
    expect(acpMock.defs[0]).toMatchObject({
      logName: 'local-agents:hermes',
      argv: ['acp'],
      clientName: 'orkas',
      extraEnv: { HERMES_YOLO_MODE: '1' },
    });
  });
});
