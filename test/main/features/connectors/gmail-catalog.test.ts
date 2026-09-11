import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  google: { google: 'disabled', gmail: 'disabled' },
  catalog: [] as any[],
}));
vi.mock('../../../../src/main/features/client_config', () => ({
  getGoogleConnectorsConfig: () => config.google,
  getServerConnectorCatalogConfig: () => config.catalog,
}));
import { connectorCatalog, findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { GOOGLE_ENTRIES } from '../../../../src/main/features/connectors/catalog-google';
import { assertConnectorRuntimeEnabled, catalogWithAvailability } from '../../../../src/main/features/connectors/availability';

describe('Gmail catalog migration', () => {
  beforeEach(() => {
    config.google = { google: 'disabled', gmail: 'disabled' };
    config.catalog = [];
  });

  it.each([
    ['disabled', 'disabled'], ['disabled', 'enabled'], ['enabled', 'visible_disabled'],
  ])('shows Composio Gmail with legacy switches %s/%s even before remote catalog loads', (google, gmail) => {
    config.google = { google, gmail };
    const visible = catalogWithAvailability(connectorCatalog());
    expect(visible.filter((entry) => entry.id === 'gmail')).toHaveLength(1);
    expect(visible.find((entry) => entry.id === 'gmail')).toMatchObject({
      auth_mode: 'composio', requires_credits: true, transport_template: null,
      usage_metering: { provider: 'composio', credits_milli_per_call: 420 },
    });
    expect(findCatalogEntry('gmail')?.oauth).toBeUndefined();
    expect(GOOGLE_ENTRIES.some((entry) => entry.id === 'gmail')).toBe(false);
    expect(() => assertConnectorRuntimeEnabled('gmail')).not.toThrow();
    // The Gmail exception must not silently enable other legacy Google connectors.
    if (google === 'disabled') {
      expect(visible.some((entry) => entry.id === 'gsearch-console')).toBe(false);
      expect(() => assertConnectorRuntimeEnabled('gsearch-console')).toThrow('connector_unsupported');
    }
  });

  it('merges server Gmail tools and pricing without duplicating it or replacing unrelated OAuth entries', () => {
    config.catalog = [
      { id: 'gmail', auth_mode: 'composio', composio: { toolkit: 'gmail', tools: [{ slug: 'GMAIL_FETCH_EMAILS' }] },
        usage_metering: { provider: 'composio', credits_milli_per_call: 500 } },
      { id: 'github', auth_mode: 'composio' },
    ];
    expect(connectorCatalog().filter((entry) => entry.id === 'gmail')).toHaveLength(1);
    expect(findCatalogEntry('gmail')).toMatchObject({
      auth_mode: 'composio', composio: { toolkit: 'gmail', tools: [{ slug: 'GMAIL_FETCH_EMAILS' }] },
      usage_metering: { credits_milli_per_call: 500 },
    });
    expect(findCatalogEntry('github')?.auth_mode).toBe('server_bridge');
  });

  it('exposes Google Drive through Composio before remote configuration and retains server tool metadata', () => {
    const drive = () => catalogWithAvailability(connectorCatalog()).filter(entry => entry.id === 'gdrive');
    expect(drive()).toHaveLength(1);
    expect(drive()[0]).toMatchObject({ auth_mode: 'composio', requires_credits: true, transport_template: null });
    expect(drive()[0].oauth).toBeUndefined();
    expect(() => assertConnectorRuntimeEnabled('gdrive')).not.toThrow();
    config.catalog = [{ id: 'gdrive', auth_mode: 'composio', composio: { toolkit: 'googledrive', tools: [{ slug: 'GOOGLEDRIVE_LIST_FILES' }] } }];
    expect(drive()).toHaveLength(1);
    expect(drive()[0].composio?.tools).toEqual([{ slug: 'GOOGLEDRIVE_LIST_FILES' }]);
    expect(() => assertConnectorRuntimeEnabled('gsearch-console')).toThrow('connector_unsupported');
  });
});
