import { describe, expect, it, vi } from 'vitest';

// The probes must stay read-only and sanitized: bounded kinds, counts, and
// ids only. The fixtures deliberately plant secret-shaped values (raw 401
// reason with an api key, profile label, encrypted connector secrets) that
// must never surface in the snapshot.
const authMock = vi.hoisted(() => ({
  hasConfiguredModel: vi.fn(() => ({ configured: true })),
  getConfig: vi.fn(async () => ({ provider: 'deepseek', model: 'deepseek-chat' })),
  getConfiguredModelCooldown: vi.fn(() => ({
    profileId: 'secret-profile-label',
    cooledUntil: Date.now() + 90_000,
    kind: 'auth',
    reason: '401 invalid api key sk-live-1234567890',
  })),
  getConfiguredModelOAuthExpiredMessage: vi.fn((): string | null => null),
}));
vi.mock('../../../../src/main/features/auth', () => authMock);

const connectorsMock = vi.hoisted(() => ({
  listInstances: vi.fn(() => [
    {
      id: 'notion',
      display_name: 'Notion',
      status: { kind: 'connected', message: 'Authorization: Bearer planted-secret-token' },
      secrets_enc: 'ORKLSEC1:must-never-leak',
    },
    { id: 'custom-x', display_name: 'Internal MCP', status: { kind: 'degraded' } },
    { id: 'broken-x', display_name: 'Broken MCP', status: { kind: 'error' } },
  ]),
}));
vi.mock('../../../../src/main/features/connectors/manager', () => connectorsMock);
vi.mock('../../../../src/main/features/connectors/availability', () => ({
  isConnectorRuntimeEnabled: vi.fn((id: string) => id !== 'broken-x'),
}));
vi.mock('../../../../src/main/features/connectors/types', () => ({
  isConnectorUsable: vi.fn((status: { kind?: string } | undefined) => (
    status?.kind === 'connected' || status?.kind === 'degraded'
  )),
}));
vi.mock('../../../../src/main/features/component_enabled', () => ({
  readEnabledMap: vi.fn(() => ({ connectors: { 'custom-x': false } })),
  isConnectorEnabledFromSnapshot: vi.fn((snapshot: { connectors: Record<string, boolean> }, id: string) => (
    snapshot.connectors[id] ?? true
  )),
}));

const kbMock = vi.hoisted(() => ({
  statusSummary: vi.fn(() => ({ total: 3, ready: 2, processing: 1, pending: 0, failed: 0 })),
}));
vi.mock('../../../../src/main/features/kb_vector', () => kbMock);

import { APP_HEALTH_DOMAINS, collectAppHealth } from '../../../../src/main/features/group_chat/app_health';

const tasksProbe = () => ({
  active_work: true,
  active_conversation_count: 3,
  other_active_conversation_count: 2,
  current_conversation: { processing: true, in_flight_actor_count: 1, active_turn_count: 1 },
});

describe('group_chat app_health probes', () => {
  it('collects a full sanitized snapshot across every domain', async () => {
    const snapshot = await collectAppHealth('u1', APP_HEALTH_DOMAINS, tasksProbe);
    expect(Object.keys(snapshot).sort()).toEqual(['connectors', 'kb', 'model', 'tasks']);

    expect(snapshot.model).toMatchObject({
      configured: true,
      default_provider: 'deepseek',
      default_model: 'deepseek-chat',
      credential_cooldown: { kind: 'auth' },
      oauth_expired: null,
    });
    const cooldown = (snapshot.model as { credential_cooldown: { seconds_remaining: number } }).credential_cooldown;
    expect(cooldown.seconds_remaining).toBeGreaterThan(0);
    expect(cooldown.seconds_remaining).toBeLessThanOrEqual(90);

    expect(snapshot.connectors).toEqual({
      configured_count: 3,
      connected_count: 1,
      usable_count: 1,
      items: [
        { id: 'notion', name: 'Notion', status: 'connected', enabled: true, usable: true },
        { id: 'custom-x', name: 'Internal MCP', status: 'degraded', enabled: false, usable: false },
        { id: 'broken-x', name: 'Broken MCP', status: 'error', enabled: false, usable: false },
      ],
    });
    expect(snapshot.kb).toEqual({ total: 3, ready: 2, processing: 1, pending: 0, failed: 0 });
    expect(snapshot.tasks).toEqual(tasksProbe());

    // Sanitization oracle: none of the planted secret material may appear.
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('sk-live-1234567890');
    expect(text).not.toContain('secret-profile-label');
    expect(text).not.toContain('ORKLSEC1');
    expect(text).not.toContain('401 invalid');
    expect(text).not.toContain('planted-secret-token');
  });

  it('returns only the requested domain', async () => {
    const snapshot = await collectAppHealth('u1', ['kb'], tasksProbe);
    expect(Object.keys(snapshot)).toEqual(['kb']);
  });

  it('caps the connector item list while keeping the true connected count', async () => {
    connectorsMock.listInstances.mockReturnValueOnce(
      Array.from({ length: 25 }, (_, i) => ({
        id: `c${i}`, display_name: `C${i}`, status: { kind: 'connected' },
      })) as never,
    );
    const snapshot = await collectAppHealth('u1', ['connectors'], tasksProbe);
    const connectors = snapshot.connectors as {
      configured_count: number; connected_count: number; usable_count: number; items: unknown[];
    };
    expect(connectors.configured_count).toBe(25);
    expect(connectors.connected_count).toBe(25);
    expect(connectors.usable_count).toBe(25);
    expect(connectors.items).toHaveLength(20);
  });

  it.each([
    ['model', () => authMock.getConfig.mockRejectedValueOnce(
      new Error('model probe leaked sk-private-model'),
    )],
    ['connectors', () => connectorsMock.listInstances.mockImplementationOnce(() => {
      throw new Error('connector probe leaked ORKLSEC1:private');
    })],
    ['kb', () => kbMock.statusSummary.mockImplementationOnce(() => {
      throw new Error('/private/library/index.sqlite');
    })],
  ] as const)(
    'degrades a failing %s probe without dropping or contaminating other domains',
    async (failedDomain, armFailure) => {
      armFailure();
      const snapshot = await collectAppHealth('u1', APP_HEALTH_DOMAINS, tasksProbe);
      expect(snapshot[failedDomain]).toEqual({ unavailable: true });
      for (const domain of APP_HEALTH_DOMAINS) {
        if (domain !== failedDomain) expect(snapshot[domain]).not.toEqual({ unavailable: true });
      }
      expect(snapshot.tasks).toEqual(tasksProbe());
      expect(JSON.stringify(snapshot)).not.toMatch(/sk-private|ORKLSEC1|index\.sqlite/i);
    },
  );

  it('isolates a failing injected task probe from model, connector, and Library status', async () => {
    const snapshot = await collectAppHealth('u1', APP_HEALTH_DOMAINS, () => {
      throw new Error('conversation content must never escape');
    });
    expect(snapshot.tasks).toEqual({ unavailable: true });
    expect(snapshot.model).not.toEqual({ unavailable: true });
    expect(snapshot.connectors).not.toEqual({ unavailable: true });
    expect(snapshot.kb).not.toEqual({ unavailable: true });
    expect(JSON.stringify(snapshot)).not.toContain('conversation content');
  });
});
