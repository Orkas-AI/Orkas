import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ipc-connectors-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseInstance(transport: any): any {
  const now = '2026-06-01T12:00:00.000Z';
  return {
    id: 'custom-secret',
    display_name: 'Secret Server',
    origin: 'custom',
    transport,
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'connected', since: 1 },
    oauth_grant: {
      account_label: 'me@example.com',
      access_token: 'oauth-access-secret',
      refresh_token: 'oauth-refresh-secret',
    },
    created_at: now,
    updated_at: now,
  };
}

describe('ipc/connectors renderer DTO', () => {
  it('does not expose stdio argv/env secrets', async () => {
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    const dto = _toClientInstanceForTest(baseInstance({
      kind: 'stdio',
      command: '/usr/local/bin/node',
      args: ['server.js', '--api-key', 'sk-secret'],
      env: { ACCESS_TOKEN: 'env-secret' },
    }), true);

    const json = JSON.stringify(dto);
    expect(dto.transport).toEqual({ kind: 'stdio', summary: 'node (3 args)' });
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('env-secret');
    expect(json).not.toContain('oauth-access-secret');
    expect(json).not.toContain('oauth-refresh-secret');
  });

  it('strips credentials, query, and fragment from streamable-http URLs', async () => {
    const { _toClientInstanceForTest } = await import('../../../src/main/ipc/connectors');
    const dto = _toClientInstanceForTest(baseInstance({
      kind: 'streamable-http',
      url: 'https://user:pass@example.com/mcp?token=sk-secret#frag',
      headers: { Authorization: 'Bearer header-secret' },
    }));

    const json = JSON.stringify(dto);
    expect(dto.transport).toEqual({ kind: 'streamable-http', summary: 'https://example.com/mcp' });
    expect(json).not.toContain('user:pass');
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('header-secret');
  });

});
