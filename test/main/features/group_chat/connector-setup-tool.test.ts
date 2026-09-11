import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectorSetupTool,
  connectorSetupKind,
  inspectConnectorSetup,
} from '../../../../src/main/features/group_chat/connector_setup_tool';
import { CONNECTOR_CATALOG } from '../../../../src/main/features/connectors/catalog';
import shopifyRequirements from '../../../../bin/shopify-setup-requirements.cjs';
import { connectorSetupGuidance } from '../../../../src/main/features/connector_setup_context';
import type {
  CatalogEntry,
  ConnectorInstance,
} from '../../../../src/main/features/connectors/types';

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'xiaohongshu-seller',
    setup_guide_id: 'xiaohongshu-ark',
    display_name: 'Xiaohongshu Seller',
    display_name_zh: '小红书电商',
    display_name_en: 'Xiaohongshu Seller',
    category: 'commerce',
    description_zh: '连接小红书店铺。',
    description_en: 'Connect a Xiaohongshu shop.',
    auth_mode: 'local_api',
    local_api: { provider: 'xiaohongshu_ark' },
    connection_setup: {
      requirement: 'provider_application',
      instructions_zh: '先申请并通过平台对接测试。',
      instructions_en: 'Apply and complete the provider integration test first.',
      guide_url: 'https://school.xiaohongshu.com/en/open/quick-start/how-to-get-app-key.html',
      guide_label_zh: '查看官方指南',
      guide_label_en: 'Open the official guide',
      fields: [
        {
          key: 'app_key',
          input: 'text',
          storage: 'credential',
          required: true,
          format: 'app_key',
          label_zh: 'App Key',
          label_en: 'App Key',
          help_zh: '从平台复制。',
          help_en: 'Copy from the provider.',
        },
        {
          key: 'app_secret',
          input: 'secret',
          storage: 'credential',
          required: true,
          format: 'secret',
          label_zh: 'App Secret',
          label_en: 'App Secret',
        },
      ],
    },
    allowed_tools: [],
    transport_template: { kind: 'stdio', command: 'connector-adapter', args: [] },
    ...overrides,
  };
}

function instance(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: 'xiaohongshu-seller',
    display_name: 'private shop label',
    transport: { kind: 'stdio', command: 'connector-adapter', args: [] },
    enabled_subtools: null,
    tools_cache: [],
    tools_cached_at: 0,
    status: { kind: 'error', message: 'provider secret error detail', at: 1 },
    oauth_grant: {
      access_token: 'secret-access-token',
      refresh_token: 'secret-refresh-token',
      expires_at: null,
      scopes: [],
      token_type: 'Bearer',
      account_label: 'private@example.com',
    },
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

async function run(
  tool: ReturnType<typeof buildConnectorSetupTool>,
  input: Record<string, unknown>,
): Promise<{ result: Record<string, any>; isError?: boolean }> {
  const output = await tool.execute(input, {} as never);
  return {
    result: JSON.parse(String(output.content)),
    ...(output.isError ? { isError: true } : {}),
  };
}

describe('connector_setup', () => {
  it('finds unconfigured Taobao in the built-in catalog without granting callable access', async () => {
    const stageConfigure = vi.fn(() => ({ ok: true as const }));
    const tool = buildConnectorSetupTool({
      uid: 'u1', language: 'zh', stageConfigure,
      dependencies: { catalog: () => CONNECTOR_CATALOG, instances: () => [],
        enabledSnapshot: () => ({ connectors: {} }) },
    });
    const searched = await run(tool, { operation: 'search', query: '淘宝' });
    expect(searched.result.results).toContainEqual(expect.objectContaining({
      connector_id: 'taobao-tmall-seller', setup_type: 'merchant_application',
      requires_extra_configuration: true, configured: false, status: 'not_configured', can_start: true,
    }));
    expect(stageConfigure).not.toHaveBeenCalled();
    const missing = await run(tool, { operation: 'search', query: 'no-such-catalog-service' });
    expect(missing.result.results).toEqual([]);
    expect(stageConfigure).not.toHaveBeenCalled();
  });

  it.each(['not_configured', 'disconnected', 'connected'] as const)(
    'offers only the connection entry for simple OAuth (%s), without complex setup or false verification', async state => {
      const candidate = CONNECTOR_CATALOG.find(item => item.id === 'notion')!;
      const bindAssistance = vi.fn(async () => {});
      const stageConfigure = vi.fn(() => ({ ok: true as const }));
      const openGuide = vi.fn(async () => ({ ok: true }));
      const observePage = vi.fn(async () => ({ ok: false, code: 'no_session' }));
      const tool = buildConnectorSetupTool({
        uid: 'u1', language: 'en', bindAssistance, stageConfigure, openGuide, observePage,
        dependencies: { catalog: () => [candidate],
          instances: () => state === 'not_configured' ? [] : [instance({ id: candidate.id,
            status: state === 'connected' ? { kind: state, since: 1 } : { kind: state } })],
          enabledSnapshot: () => ({ connectors: {} }) },
      });
      for (const operation of ['inspect', 'start']) {
        const output = await run(tool, { operation, connector_id: candidate.id });
        expect(output.result).toMatchObject({ ok: true, connector: {
          connector_id: candidate.id, setup_type: 'one_click_oauth', requires_extra_configuration: false,
          connection: { status: state }, user_actions: expect.arrayContaining(['complete_provider_login_and_consent']),
        } });
        expect(output.result).not.toHaveProperty('guidance');
        expect(output.result.connector).not.toHaveProperty('setup_guide');
        expect(output.result).not.toHaveProperty('web_assist');
        expect(output.result.connector.connection).not.toHaveProperty('verified');
      }
      expect(stageConfigure).toHaveBeenCalledExactlyOnceWith(candidate.id);
      expect(bindAssistance).not.toHaveBeenCalled();
      expect(openGuide).not.toHaveBeenCalled();
      expect(observePage).not.toHaveBeenCalled();
    },
  );

  it.each(['disabled', 'stage_rejected'] as const)('keeps simple OAuth %s recoverable without browser or binding side effects', async failure => {
    const candidate = { ...CONNECTOR_CATALOG.find(item => item.id === 'notion')!,
      ...(failure === 'disabled' ? { availability: 'visible_disabled' as const } : {}) };
    const bindAssistance = vi.fn(async () => {});
    const stageConfigure = vi.fn(() => ({ ok: false as const, error: 'Open Connectors and try again.' }));
    const openGuide = vi.fn(async () => ({ ok: true }));
    const tool = buildConnectorSetupTool({ uid: 'u1', language: 'en', bindAssistance, stageConfigure, openGuide,
      dependencies: { catalog: () => [candidate], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) } });
    const output = await run(tool, { operation: 'start', connector_id: candidate.id });
    expect(output).toMatchObject({ isError: true, result: { ok: false, error: expect.any(String) } });
    expect(output.result).not.toHaveProperty('status');
    expect(stageConfigure).toHaveBeenCalledTimes(failure === 'disabled' ? 0 : 1);
    expect(bindAssistance).not.toHaveBeenCalled();
    expect(openGuide).not.toHaveBeenCalled();
  });

  it.each(['zh', 'en', 'ja', 'pt'] as const)('delivers corrected setup facts through inspect in %s without cross-connector scope leakage', language => {
    const inspect = (id: string) => inspectConnectorSetup(
      CONNECTOR_CATALOG.find(candidate => candidate.id === id)!, language, CONNECTOR_CATALOG, [], { connectors: {} },
    );
    const shopify = inspect('shopify-admin');
    const fields = shopify.protected_fields as Array<{ key: string; help: string }>;
    const help = fields.find(field => field.key === 'client_id')!.help;
    const expectedScopes = [...shopifyRequirements.required_scopes, ...shopifyRequirements.fulfillment_scopes_any_of];
    expect(help.match(/\b(?:read|write)_[a-z_]+\b/g)).toEqual(expectedScopes);
    expect(shopify.connection).toMatchObject({ configured: false, status: 'not_configured' });
    expect(shopify.setup_guide).toMatchObject({ available: true, entry_url: 'https://dev.shopify.com/dashboard/' });
    const xhs = inspect('xiaohongshu-seller');
    const xhsFields = JSON.stringify(xhs.protected_fields);
    expect(xhsFields).not.toContain('Developer > App Key & Secret');
    for (const scope of expectedScopes) expect(xhsFields).not.toContain(scope);
    const netsuite = inspect('netsuite');
    expect(netsuite.instructions).toContain('MCP Server Connection');
    expect(netsuite.instructions).toContain('Log in using OAuth 2.0 Access Tokens');
    expect(netsuite.instructions).toContain('REST Web Services');
  });

  it('derives guidance for every built-in connector that declares extra setup', () => {
    const entries = CONNECTOR_CATALOG.filter((candidate) => (
      candidate.auth_mode === 'local_cli'
      || Boolean(candidate.connection_setup)
    ));
    expect(entries.length).toBeGreaterThan(30);
    for (const candidate of entries) {
      const inspected = inspectConnectorSetup(
        candidate,
        'zh',
        CONNECTOR_CATALOG,
        [],
        { connectors: {} },
      );
      expect(inspected).toMatchObject({
        connector_id: candidate.id,
        setup_type: expect.stringMatching(/^(one_click_oauth|api_credentials|merchant_application|enterprise_qualification|local_cli)$/),
        protected_fields: expect.any(Array),
        connection: { configured: false, status: 'not_configured' },
      });
      expect(inspected.protected_fields).toHaveLength(candidate.connection_setup?.fields.length || 0);
    }
  });

  it('classifies setup from catalog metadata without provider-specific control flow', () => {
    expect(connectorSetupKind(entry())).toBe('merchant_application');
    expect(connectorSetupKind(entry({
      connection_setup: { ...entry().connection_setup!, requirement: 'business_qualification' },
    }))).toBe('enterprise_qualification');
    expect(connectorSetupKind(entry({
      auth_mode: 'local_cli',
      local_api: undefined,
      local_cli: {
        provider: 'dingtalk',
        package_name: 'dingtalk-cli',
        package_version: '1.0.0',
        package_integrity: 'sha512-test',
        executable: 'dingtalk',
        allowed_domains: ['chat'],
      },
      connection_setup: undefined,
    }))).toBe('local_cli');
    expect(connectorSetupKind(entry({
      auth_mode: 'mcp_dcr',
      local_api: undefined,
      connection_setup: undefined,
    }))).toBe('one_click_oauth');
  });

  it('searches authored catalog text but never starts from a fuzzy result', async () => {
    const stageConfigure = vi.fn(() => ({ ok: true as const }));
    const tool = buildConnectorSetupTool({
      uid: 'u1',
      language: 'zh',
      stageConfigure,
      dependencies: {
        catalog: () => [entry()],
        instances: () => [],
        enabledSnapshot: () => ({ connectors: {} }),
      },
    });

    const searched = await run(tool, { operation: 'search', query: '小红书' });
    expect(searched.result).toMatchObject({
      ok: true,
      operation: 'search',
      results: [{
        connector_id: 'xiaohongshu-seller',
        name: '小红书电商',
        setup_type: 'merchant_application',
        configured: false,
      }],
    });
    expect(stageConfigure).not.toHaveBeenCalled();
    // The "copy an exact id, search never starts setup" rule lives in the
    // parameter descriptions; the result does not repeat it on every search.
    expect(searched.result).not.toHaveProperty('instruction');
    expect((tool.inputSchema as any).properties.connector_id.description)
      .toMatch(/exact catalog ID.*never start/i);

    const fuzzyStart = await run(tool, { operation: 'start', connector_id: '小红书' });
    expect(fuzzyStart).toMatchObject({
      isError: true,
      result: { ok: false, error: expect.stringContaining('exact catalog ID') },
    });
    expect(stageConfigure).not.toHaveBeenCalled();
  });

  it('returns catalog-authored guidance without credential values or private status details', async () => {
    const tool = buildConnectorSetupTool({
      uid: 'u1',
      language: 'zh',
      stageConfigure: () => ({ ok: true }),
      dependencies: {
        catalog: () => [entry()],
        instances: () => [instance()],
        enabledSnapshot: () => ({ connectors: { 'xiaohongshu-seller': false } }),
      },
    });

    expect(tool.inputSchema).not.toHaveProperty('properties.credentials');
    const inspected = await run(tool, {
      operation: 'inspect', connector_id: 'xiaohongshu-seller',
    });
    expect(inspected.result.connector).toMatchObject({
      connector_id: 'xiaohongshu-seller',
      setup_type: 'merchant_application',
      instructions: '先申请并通过平台对接测试。',
      protected_fields: [
        { key: 'app_key', secret: true },
        { key: 'app_secret', secret: true },
      ],
      connection: {
        configured: true,
        status: 'error',
        enabled: false,
        instances: [{ connector_id: 'xiaohongshu-seller', status: 'error', enabled: false }],
      },
    });
    const serialized = JSON.stringify(inspected.result);
    expect(inspected.result.guidance).toBe(connectorSetupGuidance());
    expect(inspected.result.connector.setup_guide).toMatchObject({
      available: true, id: 'xiaohongshu-ark',
      content: expect.stringContaining('production Ark credentials only'),
    });
    expect(inspected.result.connector.setup_guide.content).not.toContain('Taobao');
    expect(inspected.result.connector.user_actions).not.toContain('create_or_configure_provider_application');
    expect(serialized).not.toContain('provider secret error detail');
    expect(serialized).not.toContain('secret-access-token');
    expect(serialized).not.toContain('private@example.com');
    // What Commander may do and the credential boundary are stated once in the
    // tool description; inspect returns only connector-specific facts.
    expect(inspected.result.connector).not.toHaveProperty('commander_can');
    expect(inspected.result.connector).not.toHaveProperty('credential_boundary');
    expect(inspected.result.connector.user_actions).toContain('confirm_provider_application_submission_or_authorization');
    expect(tool.description).toMatch(/never put credentials in chat/i);

    const status = await run(tool, {
      operation: 'status', connector_id: 'xiaohongshu-seller',
    });
    expect(status.result).not.toHaveProperty('connector.setup_guide');
    expect(status.result.connection).toEqual({
      configured: true,
      status: 'error',
      enabled: false,
      instances: [{ connector_id: 'xiaohongshu-seller', status: 'error', enabled: false }],
    });
  });

  it('starts JD setup at the migrated portal with matching on-demand guidance, without claiming authorization', async () => {
    const candidate = CONNECTOR_CATALOG.find(item => item.id === 'jd-seller')!;
    const stageConfigure = vi.fn(() => ({ ok: true as const }));
    const openGuide = vi.fn(async () => ({ ok: true }));
    const tool = buildConnectorSetupTool({
      uid: 'u1', language: 'en', stageConfigure, openGuide,
      dependencies: { catalog: () => [candidate], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
    });
    const inspected = await run(tool, { operation: 'inspect', connector_id: candidate.id });
    expect(openGuide).not.toHaveBeenCalled();
    expect(stageConfigure).not.toHaveBeenCalled();
    const started = await run(tool, { operation: 'start', connector_id: candidate.id });
    expect(started.result).toMatchObject({ ok: true, status: 'setup_card_staged', web_assist: { opened: true } });
    expect(started.result.connector.connection).toMatchObject({ configured: false, status: 'not_configured' });
    expect(started.result.connector.connection).not.toHaveProperty('verified');
    expect(started.result.connector.setup_guide).toEqual(inspected.result.connector.setup_guide);
    expect(started.result.connector.setup_guide).toMatchObject({
      available: true, entry_url: 'https://open.jd.com/',
      content: expect.stringContaining('existing migrated application'),
    });
    expect(stageConfigure).toHaveBeenCalledExactlyOnceWith('jd-seller');
    expect(openGuide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      connectorId: 'jd-seller', url: 'https://open.jd.com/',
    }));
  });

  it('opens the authored console rather than its documentation when starting protected setup', async () => {
    const stageConfigure = vi.fn(() => ({ ok: true as const }));
    const openGuide = vi.fn(async () => ({ ok: true, state: { open: true } }));
    const tool = buildConnectorSetupTool({
      uid: 'u1',
      language: 'en',
      stageConfigure,
      openGuide,
      dependencies: {
        catalog: () => [entry()],
        instances: () => [],
        enabledSnapshot: () => ({ connectors: {} }),
      },
    });

    const started = await run(tool, {
      operation: 'start', connector_id: 'xiaohongshu-seller',
    });
    expect(started.result).toMatchObject({
      ok: true,
      operation: 'start',
      connector_id: 'xiaohongshu-seller',
      status: 'setup_card_staged',
      web_assist: { opened: true },
    });
    expect(stageConfigure).toHaveBeenCalledOnce();
    expect(stageConfigure).toHaveBeenCalledWith('xiaohongshu-seller');
    expect(openGuide).toHaveBeenCalledWith({
      connectorId: 'xiaohongshu-seller',
      url: 'https://ark.xiaohongshu.com/',
      label: 'Xiaohongshu Seller',
    });
    expect(started.result.guidance).toBe(connectorSetupGuidance());
    expect(started.result.connector.instructions).toBe(entry().connection_setup!.instructions_en);
    const inspected = await run(tool, { operation: 'inspect', connector_id: entry().id });
    expect(started.result.connector.setup_guide).toEqual(inspected.result.connector.setup_guide);
    expect(started.result.connector.setup_guide.available).toBe(true);
    // The staged card and guide outcome are the result facts; the static
    // follow-up guidance lives on the operation description instead.
    expect(started.result).not.toHaveProperty('instruction');
    expect((tool.inputSchema as any).properties.operation.description)
      .toMatch(/start stages a protected setup card/);
  });

  it.each(['not_authored', 'missing_resource', 'incompatible', 'no_entry'] as const)(
    'uses reference documentation when the entry is unavailable (%s), without inferring a console', async fault => {
      const candidate = entry({ setup_guide_id: fault === 'not_authored' ? undefined
        : fault === 'missing_resource' ? 'missing-resource'
          : fault === 'incompatible' ? 'taobao-tmall-seller' : 'woocommerce' });
      if (fault === 'no_entry') {
        // A compatible guide can intentionally omit the optional console entry.
        const tenantStore = CONNECTOR_CATALOG.find(item => item.id === 'woocommerce')!;
        Object.assign(candidate, tenantStore);
      }
      const openGuide = vi.fn(async () => ({ ok: true }));
      const tool = buildConnectorSetupTool({
        uid: 'u1', language: 'en', openGuide, stageConfigure: () => ({ ok: true }),
        dependencies: { catalog: () => [candidate], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
      });
      const result = await run(tool, { operation: 'start', connector_id: candidate.id });
      expect(openGuide).toHaveBeenCalledWith(expect.objectContaining({ url: candidate.connection_setup!.guide_url }));
      expect(result.result.connector.connection).toMatchObject({ configured: false });
      expect(result.result.connector.setup_guide).not.toHaveProperty('entry_url');
      expect(result.result.status).toBe('setup_card_staged');
    },
  );

  it('can open a verified entry without a documentation URL while inspect and status remain read-only', async () => {
    const candidate = entry({ connection_setup: { ...entry().connection_setup!, guide_url: undefined } });
    const openGuide = vi.fn(async () => ({ ok: true }));
    const stageConfigure = vi.fn(() => ({ ok: true as const }));
    const tool = buildConnectorSetupTool({
      uid: 'u1', language: 'en', openGuide, stageConfigure,
      dependencies: { catalog: () => [candidate], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
    });
    await run(tool, { operation: 'inspect', connector_id: candidate.id });
    await run(tool, { operation: 'status', connector_id: candidate.id });
    expect(openGuide).not.toHaveBeenCalled();
    expect(stageConfigure).not.toHaveBeenCalled();
    await run(tool, { operation: 'start', connector_id: candidate.id });
    expect(openGuide).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://ark.xiaohongshu.com/' }));
  });

  it('binds only explicit start and preserves an existing page on continuation', async () => {
    const bindAssistance = vi.fn(async () => {});
    const openGuide = vi.fn(async () => ({ ok: true }));
    const stageConfigure = vi.fn(() => ({ ok: true as const }));
    const tool = buildConnectorSetupTool({
      uid: 'u1', language: 'en', bindAssistance, openGuide, stageConfigure,
      observePage: async () => ({ ok: true, title: 'Application details', page_id: 'current-page' }),
      dependencies: { catalog: () => [entry()], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
    });
    await run(tool, { operation: 'inspect', connector_id: entry().id });
    await run(tool, { operation: 'status', connector_id: entry().id });
    await run(tool, { operation: 'start', connector_id: 'missing' });
    expect(bindAssistance).not.toHaveBeenCalled();
    expect(stageConfigure).not.toHaveBeenCalled();
    const result = await run(tool, { operation: 'start', connector_id: entry().id });
    expect(bindAssistance).toHaveBeenCalledWith(entry().id);
    expect(result.result.web_assist).toEqual({ opened: true });
    expect(openGuide).not.toHaveBeenCalled();
    bindAssistance.mockRejectedValueOnce(new Error('missing conversation'));
    stageConfigure.mockClear();
    const failed = await run(tool, { operation: 'start', connector_id: entry().id });
    expect(failed.isError).toBe(true);
    expect(stageConfigure).not.toHaveBeenCalled();
    expect(openGuide).not.toHaveBeenCalled();
  });

  it.each([
    { observed: { ok: false, code: 'page_loading' }, opens: 0 },
    { observed: { ok: false, code: 'no_session' }, opens: 1 },
  ])('continues a $observed.code page without discarding an in-progress form', async ({ observed, opens }) => {
    const openGuide = vi.fn(async () => ({ ok: true }));
    const observePage = vi.fn(async () => observed);
    const tool = buildConnectorSetupTool({
      uid: 'u1', language: 'en', openGuide, observePage,
      stageConfigure: () => ({ ok: true }),
      dependencies: { catalog: () => [entry()], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
    });
    const result = await run(tool, { operation: 'start', connector_id: entry().id });
    expect(observePage).toHaveBeenCalledWith(entry().id);
    expect(openGuide).toHaveBeenCalledTimes(opens);
    expect(result.result).toMatchObject({
      status: 'setup_card_staged', web_assist: { opened: true },
      connector: { connection: { configured: false, status: 'not_configured' } },
    });
  });

  it.each(['no_guide', 'no_browser', 'open_throws', 'open_denied', 'observe_throws'] as const)(
    'keeps the protected setup card recoverable when %s, without claiming connection success', async (failure) => {
      const candidate = entry();
      if (failure === 'no_guide') {
        candidate.setup_guide_id = undefined;
        candidate.connection_setup = { ...candidate.connection_setup!, guide_url: undefined };
      }
      const stageConfigure = vi.fn(() => ({ ok: true as const }));
      const bindAssistance = vi.fn(async () => {});
      const openGuide = vi.fn(async () => {
        if (failure === 'open_throws') throw new Error('private browser diagnostics');
        return { ok: false, code: 'window_unavailable' };
      });
      const tool = buildConnectorSetupTool({
        uid: 'u1', language: 'en', bindAssistance, stageConfigure,
        ...(failure === 'no_browser' ? {} : { openGuide }),
        observePage: async () => {
          if (failure === 'observe_throws') throw new Error('private browser diagnostics');
          return { ok: false, code: 'no_session' };
        },
        dependencies: { catalog: () => [candidate], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
      });
      const result = await run(tool, { operation: 'start', connector_id: candidate.id });
      expect(result.isError).toBeUndefined();
      expect(bindAssistance).toHaveBeenCalledWith(candidate.id);
      expect(stageConfigure).toHaveBeenCalledWith(candidate.id);
      expect(result.result).toMatchObject({
        ok: true, status: 'setup_card_staged', guidance: connectorSetupGuidance(),
        web_assist: { opened: false },
        connector: { connection: { configured: false, status: 'not_configured' } },
      });
      expect(result.result.connector.protected_fields).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('private browser diagnostics');
      expect(openGuide).toHaveBeenCalledTimes(['open_throws', 'open_denied'].includes(failure) ? 1 : 0);
    },
  );

  it.each(['disabled', 'unavailable_reason', 'stage_rejected'] as const)(
    'does not open a page after %s', async (failure) => {
      const candidate = entry(failure === 'disabled' ? { availability: 'visible_disabled' }
        : failure === 'unavailable_reason' ? { unavailable_reason: 'oauth_pending' } : {});
      const bindAssistance = vi.fn(async () => {});
      const stageConfigure = vi.fn(() => ({ ok: false as const, error: 'configuration view unavailable' }));
      const openGuide = vi.fn(async () => ({ ok: true }));
      const tool = buildConnectorSetupTool({
        uid: 'u1', language: 'en', bindAssistance, stageConfigure, openGuide,
        dependencies: { catalog: () => [candidate], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
      });
      const result = await run(tool, { operation: 'start', connector_id: candidate.id });
      expect(result.isError).toBe(true);
      expect(result.result.ok).toBe(false);
      expect(result.result).not.toHaveProperty('status');
      expect(openGuide).not.toHaveBeenCalled();
      expect(bindAssistance).toHaveBeenCalledTimes(failure === 'stage_rejected' ? 1 : 0);
      expect(stageConfigure).toHaveBeenCalledTimes(failure === 'stage_rejected' ? 1 : 0);
    },
  );

  it('reads fresh stored status without treating configuration or connection as proof of usable permissions', async () => {
    let instances: ConnectorInstance[] = [];
    let enabled = true;
    const bindAssistance = vi.fn(async () => {});
    const stageConfigure = vi.fn(() => ({ ok: true as const }));
    const tool = buildConnectorSetupTool({
      uid: 'u1', language: 'en', bindAssistance, stageConfigure,
      dependencies: { catalog: () => [entry()], instances: () => instances,
        enabledSnapshot: () => ({ connectors: { [entry().id]: enabled } }) },
    });
    for (const kind of ['not_configured', 'disconnected', 'connected', 'error', 'disconnected'] as const) {
      instances = kind === 'not_configured' ? [] : [instance({ status: kind === 'connected'
        ? { kind, since: 1 } : kind === 'error' ? { kind, at: 1, message: 'private error' } : { kind } })];
      enabled = kind !== 'error';
      const result = await run(tool, { operation: 'status', connector_id: entry().id });
      expect(result.result.connection).toMatchObject({
        configured: kind !== 'not_configured', status: kind, enabled: kind === 'not_configured' ? null : enabled,
      });
      expect(result.result.connection).not.toHaveProperty('verified');
      expect(result.result.connection).not.toHaveProperty('permissions');
    }
    expect(bindAssistance).not.toHaveBeenCalled();
    expect(stageConfigure).not.toHaveBeenCalled();
    expect(tool.inputSchema).toMatchObject({ properties: {
      operation: { description: expect.stringContaining('not a live verification') },
    } });
  });

  it('delegates page operations only within the exact connector scope', async () => {
    const observePage = vi.fn(async () => ({
      ok: true,
      page_id: 'page-1',
      untrusted_content: true,
      elements: [{ ref: 'e1', label: 'Create app' }],
    }));
    const actPage = vi.fn(async () => ({
      ok: false,
      code: 'user_action_required',
      reason: 'form_submission_or_authorization',
    }));
    const waitPage = vi.fn(async () => ({ ok: true, condition: 'loaded' }));
    const tool = buildConnectorSetupTool({
      uid: 'u1',
      language: 'en',
      stageConfigure: () => ({ ok: true }),
      observePage,
      actPage,
      waitPage,
      dependencies: {
        catalog: () => [entry()],
        instances: () => [],
        enabledSnapshot: () => ({ connectors: {} }),
      },
    });

    const observed = await run(tool, {
      operation: 'page_observe', connector_id: 'xiaohongshu-seller',
    });
    expect(observed.result).toMatchObject({
      ok: true,
      operation: 'page_observe',
      connector_id: 'xiaohongshu-seller',
      page_id: 'page-1',
      untrusted_content: true,
    });
    expect(observePage).toHaveBeenCalledWith('xiaohongshu-seller');

    const acted = await run(tool, {
      operation: 'page_act',
      connector_id: 'xiaohongshu-seller',
      page_id: 'page-1',
      element_ref: 'e1',
      page_action: 'click',
    });
    expect(acted.result).toMatchObject({
      ok: false,
      operation: 'page_act',
      code: 'user_action_required',
    });
    expect(actPage).toHaveBeenCalledWith('xiaohongshu-seller', expect.objectContaining({
      page_id: 'page-1', element_ref: 'e1', page_action: 'click',
    }));

    const waited = await run(tool, {
      operation: 'page_wait',
      connector_id: 'xiaohongshu-seller',
      wait_condition: 'loaded',
      timeout_ms: 1000,
    });
    expect(waited.result).toMatchObject({ ok: true, operation: 'page_wait', condition: 'loaded' });
    expect(waitPage).toHaveBeenCalledWith('xiaohongshu-seller', expect.any(Object));

    // Web Assist accepts up to 2000 characters for fill/select but only 240
    // for a page_wait text condition. The schema keeps the wider bound and the
    // parameter description states the narrower one, so the model does not
    // spend a round trip discovering it; the tool forwards the text unchanged
    // and leaves enforcement to the page layer.
    const textProperty = (tool.inputSchema as any).properties.text;
    expect(textProperty.maxLength).toBe(2000);
    expect(textProperty.description).toMatch(/page_wait \(up to 240 characters\)/);
    const longText = 'x'.repeat(300);
    await run(tool, {
      operation: 'page_wait',
      connector_id: 'xiaohongshu-seller',
      wait_condition: 'text',
      text: longText,
    });
    expect(waitPage).toHaveBeenLastCalledWith('xiaohongshu-seller', expect.objectContaining({
      wait_condition: 'text', text: longText,
    }));
  });
});
