import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { COMPOSIO_MANAGED_ENTRIES } from '../../../../src/main/features/connectors/catalog-managed';
import { CONNECTOR_CATALOG, findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { connectorActionRisk } from '../../../../src/main/features/connectors/action_policy';

describe('managed OAuth expansion', () => {
  it('offers every new service once through the existing browser authorization flow', () => {
    expect(COMPOSIO_MANAGED_ENTRIES).toHaveLength(69);
    for (const card of COMPOSIO_MANAGED_ENTRIES) {
      expect(CONNECTOR_CATALOG.filter(row => row.id === card.id), card.id).toHaveLength(1);
      expect(findCatalogEntry(card.id)).toMatchObject({
        auth_mode: 'composio', transport_template: null, requires_credits: true,
        usage_metering: { provider: 'composio', credits_milli_per_call: 420 },
      });
      expect(card.connection_setup?.fields || []).toEqual([]);
      for (const lang of ['zh', 'en', 'ja', 'pt'] as const) {
        expect(card[`description_${lang}`]?.trim().length, `${card.id}:${lang}`).toBeGreaterThan(10);
      }
    }
    expect(findCatalogEntry('github')?.auth_mode).toBe('server_bridge');
    expect(findCatalogEntry('notion')?.auth_mode).toBe('mcp_dcr');
  });

  it('renders real provider artwork without executable or remotely loaded SVG content', async () => {
    const definedIds = new Set<string>();
    for (const card of COMPOSIO_MANAGED_ENTRIES) {
      expect(card.icon_source_url, card.id).toMatch(/^https:\/\/logos\.composio\.dev\/api\//);
      expect(card.icon_source_sha256, card.id).toMatch(/^[a-f0-9]{64}$/);
      const svg = card.icon_svg || '';
      expect(svg, card.id).toMatch(/^<svg[^>]+viewBox=/);
      expect(svg, card.id).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=|(?:href|src)=["'](?!#)/i);
      for (const match of svg.matchAll(/\bid="([^"]+)"/g)) {
        expect(definedIds.has(match[1]), `${card.id}:${match[1]}`).toBe(false);
        definedIds.add(match[1]);
      }
      const { data, info } = await sharp(Buffer.from(svg))
        .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let visible = 0;
      for (let index = 3; index < data.length; index += info.channels) if (data[index] > 0) visible++;
      expect(visible, card.id).toBeGreaterThan(100);
    }
  });

  it('uses the trusted adapter policy for new services while keeping custom metadata untrusted', () => {
    const tool = {
      name: 'TRELLO_ADD_CARDS_ACTIONS_COMMENTS_BY_ID_CARD',
      annotations: { readOnlyHint: true },
      orkas_action_policy: { risk: 'H', confirmation: 'fresh', max_batch_size: 25, sensitive_operation: 'external_or_workflow_change' },
    } as const;
    const instance = { id: 'trello', origin: 'catalog', composio_grant: { connection_id: 'opaque' } } as any;
    expect(connectorActionRisk(instance, tool as any).risk).toBe('H');
    expect(connectorActionRisk({ ...instance, id: 'custom-untrusted', origin: 'custom' }, {
      ...tool, orkas_action_policy: { ...tool.orkas_action_policy, risk: 'R' },
    } as any).risk).toBe('H');
  });
});
