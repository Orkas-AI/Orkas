import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

function sampleInstance(id = 'github') {
  const now = '2026-06-01T12:00:00.000Z';
  return {
    id,
    display_name: id,
    transport: {
      kind: 'streamable-http' as const,
      url: `https://example.com/${id}`,
      headers: { Authorization: 'Bearer access-token' },
    },
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connected' as const, since: 1 },
    oauth_grant: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60_000,
      token_type: 'Bearer',
    },
    created_at: now,
    updated_at: now,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-connectors-registry-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('features/connectors/registry', () => {
  it('writes a tombstone on remove and clears it when reconnecting the same id', async () => {
    const uid = 'uid-delete';
    const file = path.join(tmpDir, uid, 'cloud', 'config', 'connectors.json');
    const registry = await import('../../../../src/main/features/connectors/registry');

    await registry.upsert(uid, sampleInstance('github'));
    await registry.setReauthorizeHint(uid, 'github', true);
    expect(await registry.remove(uid, 'github')).toBe(true);

    const removed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(removed.connections.github).toBeUndefined();
    expect(removed.oauth_hints.github).toBeUndefined();
    expect(Date.parse(removed._deleted_at.github)).not.toBeNaN();

    await registry.upsert(uid, sampleInstance('github'));
    const reconnected = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(reconnected.connections.github).toBeTruthy();
    expect(reconnected._deleted_at.github).toBeUndefined();
  });

  it('preserves undecryptable secrets_enc when patching metadata', async () => {
    const uid = 'uid-renamed';
    const originalSeed = 'uid-original';
    const file = path.join(tmpDir, uid, 'cloud', 'config', 'connectors.json');
    const cryptoVault = await import('../../../../src/main/util/crypto-vault');
    const registry = await import('../../../../src/main/features/connectors/registry');

    const originalSecrets = cryptoVault.encrypt(originalSeed, JSON.stringify({
      oauth_grant: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: Date.now() + 60_000,
      },
      transport: {
        kind: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { ACCESS_TOKEN: 'access-token' },
      },
    }));

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      connections: {
        gmail: {
          id: 'gmail',
          display_name: 'Gmail',
          enabled_subtools: null,
          tools_cache: [],
          tools_cached_at: 0,
          status: { kind: 'connected', since: 1 },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          secrets_enc: originalSecrets,
        },
      },
    }, null, 2));

    const loaded = registry.load(uid);
    expect(loaded.connections.gmail.oauth_grant).toBeUndefined();
    expect(loaded.connections.gmail.status).toMatchObject({
      kind: 'error',
      message: 'connector_reconnect_required',
    });
    const beforePatch = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(beforePatch.connections.gmail.status.kind).toBe('connected');
    expect(beforePatch.connections.gmail.secrets_enc).toBe(originalSecrets);

    await registry.update(uid, 'gmail', (cur) => ({
      ...cur,
      status: { kind: 'error', message: 'transport unresolved', at: 2 },
      updated_at: '2026-01-01T00:01:00.000Z',
    }));

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.connections.gmail.status.kind).toBe('error');
    expect(after.connections.gmail.secrets_enc).toBe(originalSecrets);
  });
});
