import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTOR_CATALOG } from '../../../../src/main/features/connectors/catalog';

const root = path.join(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('public connector boundary', () => {
  it('keeps every catalog connector on a public OAuth mode without credit metering', () => {
    expect(CONNECTOR_CATALOG).toHaveLength(21);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'mcp_dcr')).toHaveLength(11);
    expect(CONNECTOR_CATALOG.filter((entry) => entry.auth_mode === 'server_bridge')).toHaveLength(10);
    for (const entry of CONNECTOR_CATALOG) {
      expect(['server_bridge', 'mcp_dcr']).toContain(entry.auth_mode);
      expect(entry.icon_svg).toMatch(/^<svg\b/);
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

  it('pins connector OAuth to the global HTTPS bridge with no loopback or environment override', () => {
    const bridge = read('src/main/features/connectors/_server_bridge.ts');
    const marketplace = read('src/main/features/marketplace.ts');
    const oauthSources = [
      bridge,
      read('src/main/features/connectors/oauth.ts'),
      read('src/main/features/connectors/oauth-dcr.ts'),
    ].join('\n');

    expect(bridge).toContain('return apiBase();');
    expect(marketplace).toContain("const GLOBAL_PROD_API_BASE = 'https://orkas.ai' + '/api';");
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
