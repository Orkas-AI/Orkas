import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTOR_CATALOG } from '../../../../src/main/features/connectors/catalog';

const root = path.join(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('public connector boundary', () => {
  it('keeps public OAuth modes and confines credit metering to Composio', () => {
    for (const entry of CONNECTOR_CATALOG) {
      expect(['server_bridge', 'mcp_dcr', 'composio']).toContain(entry.auth_mode);
      expect(entry.icon_svg).toMatch(/^<svg\b/);
      if (entry.auth_mode === 'composio') {
        expect(entry).toMatchObject({
          requires_credits: true,
          transport_template: null,
          usage_metering: { provider: 'composio' },
        });
        expect(entry.oauth).toBeUndefined();
        continue;
      }
      if (entry.auth_mode === 'mcp_dcr') {
        expect(entry.transport_template?.kind).toBe('streamable-http');
        expect(entry.transport_template && 'url' in entry.transport_template
          ? entry.transport_template.url
          : '').toMatch(/^https:\/\//);
      }
      for (const forbiddenKey of [
        `usage_${'metering'}`,
        `credits_milli_${'per_call'}`,
        `connect_requires_${'credits'}`,
      ]) {
        expect((entry as any)[forbiddenKey]).toBeUndefined();
      }
    }
  });

  it.each([
    [false, 'http://localhost:8888/api'],
    [true, 'https://orkas.ai/api'],
  ])('routes connectors for isPackaged=%s without changing marketplace routing', async (isPackaged, expected) => {
    vi.resetModules();
    vi.doMock('electron', () => ({ app: { isPackaged } }));
    const marketplaceBase = vi.fn(() => 'https://orkas.ai/api');
    vi.doMock('../../../../src/main/features/marketplace', () => ({ apiBase: marketplaceBase }));
    try {
      const { accountApiBase, tokenStore } = await import('../../../../src/main/features/connectors/_server_bridge');
      expect(accountApiBase()).toBe(expected);
      expect(tokenStore.authHeaders()).toEqual({});
      expect(marketplaceBase).toHaveBeenCalledTimes(isPackaged ? 1 : 0);
    } finally {
      vi.doUnmock('electron');
      vi.doUnmock('../../../../src/main/features/marketplace');
      vi.resetModules();
    }
  });

  it('keeps connector endpoint selection centralized without arbitrary environment overrides', () => {
    const oauthSources = [
      read('src/main/features/connectors/oauth.ts'),
      read('src/main/features/connectors/oauth-dcr.ts'),
      read('src/main/features/connectors/manager.ts'),
    ].join('\n');
    expect(oauthSources).not.toMatch(/http:\/\/(?:localhost|127\.0\.0\.1)|ORKAS_API_BASE_URL|OAUTH_REDIRECT_BASE/);
  });

  it('ships and boots a connector-only callback receiver', () => {
    const main = read('src/main/index.ts');
    const pkg = JSON.parse(read('package.json'));
    const sourceLauncher = read('run.sh');

    expect(main).toContain('registerConnectorProtocol();');
    expect(main).toContain('await consumeColdLaunchConnectorCallback();');
    expect(pkg.build.protocols).toEqual(expect.arrayContaining([
      expect.objectContaining({ schemes: expect.arrayContaining(['orkas']) }),
    ]));
    expect(sourceLauncher).toContain('scripts/prepare-source-protocol.cjs');
  });

  it('keeps MCP DCR credentials local and excludes account-scoped DCR grant hosting', () => {
    const dcr = read('src/main/features/connectors/oauth-dcr.ts');
    const manager = read('src/main/features/connectors/manager.ts');
    const sources = `${dcr}\n${manager}`;

    expect(sources).not.toContain('/connectors/oauth/dcr-store');
    expect(sources).not.toContain('storeDcrServerManaged');
    expect(sources).not.toContain('refreshDcrServerManaged');
    expect(dcr).toContain('pending.resolve({ grant: localGrant, client: pending.client });');
    expect(manager).toContain('dcrClient = result.client;');
  });
});
