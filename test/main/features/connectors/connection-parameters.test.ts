import { describe, expect, it } from 'vitest';

import { resolveCatalogConnection } from '../../../../src/main/features/connectors/connection-parameters';
import type { CatalogEntry } from '../../../../src/main/features/connectors/types';

function netSuiteEntry(): CatalogEntry {
  return {
    id: 'netsuite',
    display_name: 'Oracle NetSuite',
    category: 'commerce',
    description_zh: 'NetSuite',
    description_en: 'NetSuite',
    auth_mode: 'mcp_dcr',
    connection_setup: {
      fields: [{
        key: 'account_id',
        input: 'text',
        label_zh: 'Account ID',
        label_en: 'Account ID',
        required: true,
        format: 'netsuite_account_id',
      }],
    },
    transport_template: {
      kind: 'streamable-http',
      url: 'https://{{account_id}}.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools',
    },
  };
}

describe('catalog connector connection parameters', () => {
  it('binds a NetSuite sandbox account to its normalized Oracle account domain', () => {
    const source = netSuiteEntry();
    const resolved = resolveCatalogConnection(source, { account_id: ' 123456_SB1 ' });

    expect(resolved.parameters).toEqual({ account_id: '123456_SB1' });
    expect(resolved.entry.transport_template).toMatchObject({
      kind: 'streamable-http',
      url: 'https://123456-sb1.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools',
    });
    expect((source.transport_template as { url: string }).url).toContain('{{account_id}}');
  });

  it('rejects missing, extra, and host-injection values before OAuth starts', () => {
    const entry = netSuiteEntry();

    expect(() => resolveCatalogConnection(entry)).toThrow('parameters required');
    expect(() => resolveCatalogConnection(entry, {})).toThrow('parameter required');
    expect(() => resolveCatalogConnection(entry, {
      account_id: '123456',
      token_endpoint: 'https://evil.example/token',
    })).toThrow('unknown connector parameter');
    for (const value of [
      'evil.example',
      '123456/path',
      '123456@suitetalk.api.netsuite.com',
      '-123456',
      '123456-',
      'a'.repeat(64),
    ]) {
      expect(() => resolveCatalogConnection(entry, { account_id: value })).toThrow(
        'invalid NetSuite account ID',
      );
    }
  });

  it('rejects parameters for catalog entries that do not declare a setup contract', () => {
    const entry = { ...netSuiteEntry(), connection_setup: undefined };
    expect(resolveCatalogConnection(entry)).toEqual({ entry });
    expect(() => resolveCatalogConnection(entry, { account_id: '123456' })).toThrow(
      'does not accept connection parameters',
    );
  });
});
