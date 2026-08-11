import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));
vi.mock('../../../../src/main/util/bundled-runtime', () => ({
  bundledNodeExecutable: () => '/opt/orkas/runtime/node',
}));

import { PC_ROOT } from '../../../../src/main/paths';
import { applyTemplate } from '../../../../src/main/features/connectors/apply-template';
import type {
  CatalogEntry,
  OAuthGrant,
  TransportTemplate,
} from '../../../../src/main/features/connectors/types';

const grant: OAuthGrant = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: Date.now() + 60_000,
  scopes: [],
  token_type: 'provider-specific-value',
};

function entry(transport_template: TransportTemplate | null): CatalogEntry {
  return {
    id: 'test',
    display_name: 'Test',
    category: 'productivity',
    description_zh: '测试',
    description_en: 'Test',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'test' },
    transport_template,
  };
}

describe('connector OAuth transport materialization', () => {
  it('injects a token into an ordinary stdio env without Electron-only variables', () => {
    expect(applyTemplate(entry({
      kind: 'stdio',
      command: 'third-party-mcp',
      args: ['--stdio'],
      oauth_env_key: 'SERVICE_ACCESS_TOKEN',
    }), grant)).toEqual({
      kind: 'stdio',
      command: 'third-party-mcp',
      args: ['--stdio'],
      env: { SERVICE_ACCESS_TOKEN: 'access-token' },
    });
  });

  it('resolves app-owned adapter placeholders to bundled Node without an Electron marker', () => {
    expect(applyTemplate(entry({
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/service-mcp.cjs'],
      oauth_env_key: 'SERVICE_ACCESS_TOKEN',
      proxy_target_url: 'https://api.service.test/',
    }), grant)).toEqual({
      kind: 'stdio',
      command: '/opt/orkas/runtime/node',
      args: [`${PC_ROOT}/bin/service-mcp.cjs`],
      env: {
        SERVICE_ACCESS_TOKEN: 'access-token',
        ORKAS_NODE: '/opt/orkas/runtime/node',
        ORKAS_BUNDLED_NODE: '/opt/orkas/runtime/node',
        ORKAS_PC_DIR: PC_ROOT,
      },
      proxyTargetUrl: 'https://api.service.test/',
    });
  });

  it('builds synthesized Notion headers without exposing a second token channel', () => {
    const transport = applyTemplate(entry({
      kind: 'stdio',
      command: 'notion-mcp',
      args: [],
      env_synthesizer: 'notion_oauth_headers',
    }), grant);

    expect(transport).toMatchObject({
      kind: 'stdio',
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: 'Bearer access-token',
          'Notion-Version': '2022-06-28',
        }),
      },
    });
  });

  it('always emits the literal Bearer scheme for HTTP transports', () => {
    expect(applyTemplate(entry({
      kind: 'streamable-http',
      url: 'https://mcp.service.test/mcp',
    }), grant)).toEqual({
      kind: 'streamable-http',
      url: 'https://mcp.service.test/mcp',
      headers: { Authorization: 'Bearer access-token' },
    });
    expect(applyTemplate(entry({
      kind: 'streamable-http',
      url: 'https://mcp.service.test/mcp',
      oauth_header_key: 'X-Service-Authorization',
    }), grant)).toMatchObject({
      headers: { 'X-Service-Authorization': 'Bearer access-token' },
    });
  });

  it('rejects missing or ambiguous credential mappings before a connector can start', () => {
    expect(() => applyTemplate(entry(null), grant)).toThrow('not installable');
    expect(() => applyTemplate(entry({
      kind: 'stdio',
      command: 'service',
      args: [],
    }), grant)).toThrow('needs either oauth_env_key or env_synthesizer');
    expect(() => applyTemplate(entry({
      kind: 'stdio',
      command: 'service',
      args: [],
      oauth_env_key: 'TOKEN',
      env_synthesizer: 'notion_oauth_headers',
    }), grant)).toThrow('cannot set both');
    expect(() => applyTemplate(entry({
      kind: 'stdio',
      command: 'service',
      args: [],
      env_synthesizer: 'unknown',
    }), grant)).toThrow('unknown env_synthesizer');
    expect(() => applyTemplate(entry({
      kind: 'stdio',
      command: 'service',
      args: [],
      oauth_env_key: 'TOKEN',
    }), { ...grant, access_token: '   ' })).toThrow('has no access_token');
  });

  it('rejects unsafe mapping keys and unknown app placeholders', () => {
    expect(() => applyTemplate(entry({
      kind: 'stdio',
      command: 'service',
      args: [],
      oauth_env_key: '__proto__',
    }), grant)).toThrow('invalid OAuth environment variable name');
    expect(() => applyTemplate(entry({
      kind: 'streamable-http',
      url: 'https://mcp.service.test/mcp',
      oauth_header_key: 'Authorization\r\nX-Leak',
    }), grant)).toThrow('invalid OAuth HTTP header name');
    expect(() => applyTemplate(entry({
      kind: 'stdio',
      command: '${ORKAS_NDOE}',
      args: [],
      oauth_env_key: 'TOKEN',
    }), grant)).toThrow('unknown placeholder');
  });
});
