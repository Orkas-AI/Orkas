import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_UID = 'u-connectors';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-connectors-secret-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sampleInstance() {
  const now = new Date().toISOString();
  return {
    id: 'github',
    display_name: 'GitHub',
    transport: {
      kind: 'streamable-http' as const,
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer access-secret' },
    },
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connected' as const, since: 1 },
    oauth_grant: {
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      expires_at: Date.now() + 60_000,
      scopes: ['repo'],
      token_type: 'Bearer',
      account_label: 'dev@example.com',
    },
    created_at: now,
    updated_at: now,
  };
}

describe('connectors registry secret storage', () => {
  it('writes token-bearing fields as local-secret ciphertext', async () => {
    const registry = await import('../../../../src/main/features/connectors/registry');
    const paths = await import('../../../../src/main/paths');

    await registry.upsert(TEST_UID, sampleInstance());

    const raw = fs.readFileSync(paths.userConnectorsConfigFile(TEST_UID), 'utf8');
    expect(raw).not.toContain('access-secret');
    expect(raw).not.toContain('refresh-secret');
    const disk = JSON.parse(raw);
    expect(disk.connections.github.oauth_grant).toBeUndefined();
    expect(String(disk.connections.github.secrets_enc)).toMatch(/^T1JLVkFVTFQx/);

    const loaded = registry.load(TEST_UID);
    expect(loaded.connections.github.oauth_grant?.access_token).toBe('access-secret');
    expect(loaded.connections.github.transport.kind).toBe('streamable-http');
  });

  it('migrates previous per-instance crypto-vault secrets on read', async () => {
    const paths = await import('../../../../src/main/paths');
    const cryptoVault = await import('../../../../src/main/util/crypto-vault');
    const registry = await import('../../../../src/main/features/connectors/registry');
    const file = paths.userConnectorsConfigFile(TEST_UID);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const inst = sampleInstance();
    const { oauth_grant, transport, ...rest } = inst;
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      connections: {
        github: {
          ...rest,
          secrets_enc: cryptoVault.encrypt(TEST_UID, JSON.stringify({ oauth_grant, transport })),
        },
      },
    }, null, 2), 'utf8');

    const loaded = registry.load(TEST_UID);
    expect(loaded.connections.github.oauth_grant?.refresh_token).toBe('refresh-secret');

    const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(String(migrated.connections.github.secrets_enc)).toMatch(/^T1JLVkFVTFQx/);
    expect(JSON.stringify(migrated)).not.toContain('refresh-secret');
  });
});
