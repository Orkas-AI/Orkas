import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const require = createRequire(import.meta.url);

describe('connector catalog', () => {
  it('ships complete four-locale copy for every built-in card and setup surface', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const missingCopy = (items: unknown[]) => {
      const missing: string[] = [];
      const visit = (node: any, location: string) => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (/^(description|label|help|instructions|callback_help|guide_label)_en$/.test(key) && value) {
            for (const lang of ['zh', 'ja', 'pt']) {
              const sibling = key.replace(/_en$/, `_${lang}`);
              if (typeof node[sibling] !== 'string' || !node[sibling].trim()) missing.push(`${location}.${sibling}`);
            }
          }
          if (value && typeof value === 'object') visit(value, `${location}.${key}`);
        }
      };
      items.forEach((item: any) => visit(item, item.id));
      return missing;
    };
    expect(CONNECTOR_CATALOG.length).toBeGreaterThan(100);
    expect(missingCopy(CONNECTOR_CATALOG)).toEqual([]);
    // Negative control: a single omitted form label must be detected, even if English exists.
    const broken = [{ id: 'canary', connection_setup: { fields: [{ label_en: 'Shop ID', label_zh: '店铺 ID', label_pt: 'ID da loja' }] } }];
    expect(missingCopy(broken)).toEqual(['canary.connection_setup.fields.0.label_ja']);
  });

  it('provides a localized HTTPS guide for every built-in connector that requires setup fields', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const setupEntries = CONNECTOR_CATALOG.filter((entry) => entry.connection_setup?.fields?.length);
    expect(setupEntries.length).toBeGreaterThan(0);
    expect(setupEntries.flatMap((entry) => {
      const setup = entry.connection_setup;
      if (!setup?.guide_url?.match(/^https:\/\//)) return [`${entry.id}.guide_url`];
      return ['zh', 'en', 'ja', 'pt']
        .filter((lang) => !String(setup[`guide_label_${lang}` as keyof typeof setup] || '').trim())
        .map((lang) => `${entry.id}.guide_label_${lang}`);
    })).toEqual([]);
  });

  it('offers only production for new commerce connections while retaining legacy PayPal identity', async () => {
    const { connectorCatalog, findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    for (const entry of connectorCatalog()) {
      for (const field of entry.connection_setup?.fields || []) {
        expect(field.options?.map(option => option.value) || [], entry.id).not.toContain('sandbox');
      }
      expect(entry.connection_variants?.map(variant => variant.catalog_id) || [], entry.id)
        .not.toContain('paypal-sandbox');
    }
    for (const id of ['shopee', 'square', 'instacart-shopping', 'reloadly', 'walmart-marketplace', 'ebay-seller', 'amazon-seller-central']) {
      expect(findCatalogEntry(id)?.connection_setup?.fields.map(field => field.key), id)
        .not.toContain('environment');
    }
    expect(findCatalogEntry('paypal')?.transport_template).toMatchObject({ url: 'https://mcp.paypal.com/http' });
    expect(findCatalogEntry('paypal-sandbox')).toMatchObject({
      catalog_parent_id: 'paypal', transport_template: { url: 'https://mcp.sandbox.paypal.com/http' },
    });
  });
  it('keeps every spawned local adapter in the packaged entrypoint contract', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const { CONNECTOR_CATALOG_ENTRYPOINTS } = require('../../../../bin/packaged-entrypoint-gate.cjs') as {
      CONNECTOR_CATALOG_ENTRYPOINTS: readonly string[];
    };
    const actual = catalog.connectorCatalog()
      .flatMap((entry) => entry.transport_template?.kind === 'stdio'
        ? entry.transport_template.args || []
        : [])
      .map((arg) => String(arg).match(/\/bin\/([A-Za-z0-9._-]+\.cjs)$/)?.[1] || '')
      .filter(Boolean)
      .sort();

    expect([...new Set(actual)]).toEqual([...CONNECTOR_CATALOG_ENTRYPOINTS].sort());
  });

  it('includes official DCR remote MCP connectors', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');

    const expected = [
      ['linear', 'Linear', 'productivity', 'https://mcp.linear.app/mcp'],
      ['atlassian', 'Atlassian', 'productivity', 'https://mcp.atlassian.com/v1/mcp/authv2'],
      ['airtable', 'Airtable', 'data', 'https://mcp.airtable.com/mcp'],
      ['gitlab', 'GitLab', 'developer', 'https://gitlab.com/api/v4/mcp'],
      ['sentry', 'Sentry', 'developer', 'https://mcp.sentry.dev/mcp'],
      ['cloudflare', 'Cloudflare', 'developer', 'https://mcp.cloudflare.com/mcp'],
      ['stripe', 'Stripe', 'developer', 'https://mcp.stripe.com'],
      ['supabase', 'Supabase', 'developer', 'https://mcp.supabase.com/mcp'],
      ['close', 'Close', 'productivity', 'https://mcp.close.com/mcp'],
      ['webflow', 'Webflow', 'productivity', 'https://mcp.webflow.com/mcp'],
    ];

    for (const [id, displayName, category, url] of expected) {
      expect(catalog.findCatalogEntry(id)).toMatchObject({
        id,
        display_name: displayName,
        category,
        auth_mode: 'mcp_dcr',
        transport_template: {
          kind: 'streamable-http',
          url,
          oauth_header_key: 'Authorization',
        },
      });
    }
  });

  it('includes the official-CLI domestic collaboration batch with governed tools and real artwork provenance', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const domestic = await import('../../../../src/main/features/connectors/catalog-domestic');
    const runtime = await import('../../../../src/main/features/connectors/local-cli');
    const expected = [
      ['wecom', 'wecom', undefined, '@wecom/cli', '1.2.0', 'https://api.iconify.design/tdesign/logo-wecom.svg', '8aa5f73c8b17c0229ffe431bee8dfc327ccad1333352cd99159dc7add1249f13', '30870884eb42e179c6c7ab992690b5455e420b754f4d9d7b04cb609f25c47a69'],
      ['feishu', 'lark', 'feishu', '@larksuite/cli', '1.0.93', 'https://framerusercontent.com/images/yjUmyrg0qV5d2Glkjn9sDqzacY.svg', '8685f45f473cf24b93dc74b4de60ca62ff4500b098c61ceb9915a05f86c8d6f4', '90652b2b052c89dacdc7aed033f17da193db943d3d2e09c246d6036490ef40d6'],
      ['lark', 'lark', 'lark', '@larksuite/cli', '1.0.93', 'https://framerusercontent.com/images/yjUmyrg0qV5d2Glkjn9sDqzacY.svg', '8685f45f473cf24b93dc74b4de60ca62ff4500b098c61ceb9915a05f86c8d6f4', '90652b2b052c89dacdc7aed033f17da193db943d3d2e09c246d6036490ef40d6'],
      ['dingtalk', 'dingtalk', undefined, 'dingtalk-workspace-cli', '1.0.61', 'https://api.iconify.design/ant-design/dingtalk.svg', '5d9022d5b091b35a818e62fafdfcdb86955f339940308f33d470d99d18956a84', '8ee000fa0f9fa9094dad5a282ee5672feb4940dae2e3bd5c92a7f9055579bf17'],
    ] as const;

    for (const [id, provider, brand, packageName, packageVersion, iconSourceUrl, iconSourceSha256, iconHash] of expected) {
      const entry = catalog.findCatalogEntry(id);
      expect(entry).toMatchObject({
        id,
        category: 'communication',
        auth_mode: 'local_cli',
        local_cli: {
          provider,
          package_name: packageName,
          package_version: packageVersion,
          ...(brand ? { brand } : {}),
        },
        transport_template: {
          kind: 'stdio',
          args: ['${ORKAS_PC_DIR}/bin/local-cli-mcp-server.cjs'],
        },
      });
      expect(entry?.local_cli?.package_integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(entry?.local_cli?.allowed_domains.length).toBeGreaterThanOrEqual(13);
      expect(entry?.allowed_tools).toEqual([...domestic.LOCAL_CLI_TOOLS]);
      expect(Object.keys(entry?.tool_policies || {}).sort()).toEqual([...domestic.LOCAL_CLI_TOOLS].sort());
      expect(entry?.tool_policies).toMatchObject({
        execute_read: { risk: 'R', confirmation: 'none' },
        execute_write: { risk: 'W', confirmation: 'preview' },
        execute_high_impact: { risk: 'H', confirmation: 'fresh' },
        execute_destructive: { risk: 'D', confirmation: 'destructive' },
      });
      expect(entry?.icon_svg).toContain('<path');
      expect(entry?.icon_svg).not.toContain('<image');
      expect(entry?.icon_source_url).toBe(iconSourceUrl);
      expect(entry?.icon_source_sha256).toBe(iconSourceSha256);
      expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(iconHash);
      expect(entry?.local_cli).toMatchObject(runtime.LOCAL_CLI_MANIFESTS[provider]);
    }

    expect(catalog.findCatalogEntry('feishu')?.connection_variants).toBeUndefined();
    expect(catalog.findCatalogEntry('lark')?.catalog_parent_id).toBe('feishu');
    expect(catalog.findCatalogEntry('wecom')).toMatchObject({
      display_name_zh: '企业微信',
      display_name_en: 'WeCom',
    });
    expect(catalog.findCatalogEntry('feishu')).toMatchObject({
      display_name_zh: '飞书',
      display_name_en: 'Lark',
      local_cli: { provider: 'lark', brand: 'feishu' },
    });
    expect(catalog.findCatalogEntry('dingtalk')).toMatchObject({
      display_name_zh: '钉钉',
      display_name_en: 'DingTalk',
    });
  });

  it('includes Xero through its official PKCE CLI with full governed accounting coverage', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const domestic = await import('../../../../src/main/features/connectors/catalog-domestic');
    const runtime = await import('../../../../src/main/features/connectors/local-cli');
    const entry = catalog.findCatalogEntry('xero');

    expect(entry).toMatchObject({
      id: 'xero',
      display_name: 'Xero',
      category: 'commerce',
      auth_mode: 'local_cli',
      icon_source_url: 'https://api.iconify.design/logos/xero.svg',
      icon_source_sha256: '6850f5259ff70c8d5760c9d30f7e66ba07ad4d79b85be769e53f934fc5d5ebda',
      local_cli: {
        provider: 'xero',
        package_name: '@xeroapi/xero-command-line',
        package_version: '0.0.7',
        executable: 'xero',
      },
      transport_template: {
        kind: 'stdio',
        args: ['${ORKAS_PC_DIR}/bin/local-cli-mcp-server.cjs'],
      },
    });
    expect(entry?.icon_svg).toContain('fill="#1fc0e7"');
    expect(entry?.icon_svg).not.toContain('<image');
    expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(
      'e9f28c11b33b516824cf535f3153d9c42276224fe189481a38cd8f3b12a0b993',
    );
    expect(entry?.allowed_tools).toEqual([...domestic.LOCAL_CLI_TOOLS]);
    expect(entry?.local_cli).toMatchObject(runtime.LOCAL_CLI_MANIFESTS.xero);
    expect(entry?.local_cli?.allowed_domains).toEqual(expect.arrayContaining([
      'contacts', 'invoices', 'payments', 'bank-transactions', 'reports',
    ]));
  });

  it('keeps every newly reviewed connector icon traceable and rejects accidental brand reuse', async () => {
    const commerce = await import('../../../../src/main/features/connectors/catalog-commerce');
    const direct = await import('../../../../src/main/features/connectors/catalog-direct-commerce');
    const domestic = await import('../../../../src/main/features/connectors/catalog-domestic');
    const localCommerce = await import('../../../../src/main/features/connectors/catalog-local-commerce');
    const remote = await import('../../../../src/main/features/connectors/catalog-remote-commerce');
    const auditedEntries = [
      ...commerce.COMPOSIO_COMMERCE_ENTRIES,
      ...direct.DIRECT_COMMERCE_ENTRIES,
      ...domestic.DOMESTIC_COLLABORATION_ENTRIES,
      ...localCommerce.LOCAL_COMMERCE_ENTRIES,
      ...remote.REMOTE_COMMERCE_ENTRIES,
    ];

    expect(auditedEntries).toHaveLength(96);
    expect(auditedEntries.map((entry) => entry.id)).toEqual(expect.arrayContaining(['shopee', 'tiktok-shop']));
    const idsByIconHash = new Map<string, string[]>();
    for (const entry of auditedEntries) {
      expect(entry.icon_source_url, entry.id).toMatch(/^https:\/\//);
      expect(entry.icon_source_sha256, entry.id).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.icon_svg, entry.id).toMatch(/^<svg(?:\s|>)/i);
      expect(entry.icon_svg, entry.id).toContain('width="100%"');
      expect(entry.icon_svg, entry.id).toContain('height="100%"');
      expect(entry.icon_svg, entry.id).not.toMatch(/<(?:script|foreignObject|iframe|image|use)\b/i);
      const iconHash = createHash('sha256').update(entry.icon_svg || '').digest('hex');
      idsByIconHash.set(iconHash, [...(idsByIconHash.get(iconHash) || []), entry.id]);
    }

    const duplicateBrandGroups = [...idsByIconHash.values()]
      .filter((ids) => ids.length > 1)
      .map((ids) => ids.sort())
      .sort(([left], [right]) => left.localeCompare(right));
    expect(duplicateBrandGroups).toEqual([
      ['feishu', 'lark'],
      ['paypal', 'paypal-sandbox'],
    ]);
  });

  it('renders every connector icon as visible ink at the card size', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const visibleInkPixels = async (svg: string) => {
      const pixels = await sharp(Buffer.from(svg))
        .resize(20, 20, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .flatten({ background: '#fff' })
        .removeAlpha()
        .raw()
        .toBuffer();
      let visible = 0;
      for (let offset = 0; offset < pixels.length; offset += 3) {
        if (Math.max(255 - pixels[offset], 255 - pixels[offset + 1], 255 - pixels[offset + 2]) > 24) visible += 1;
      }
      return visible;
    };

    const emptyClip = '<svg viewBox="0 0 20 20"><defs><clipPath id="empty"><rect /></clipPath></defs><g clip-path="url(#empty)"><rect width="20" height="20" fill="black" /></g></svg>';
    expect(await visibleInkPixels(emptyClip)).toBe(0);
    for (const entry of CONNECTOR_CATALOG) {
      expect(entry.icon_svg, entry.id).toBeTruthy();
      expect(await visibleInkPixels(entry.icon_svg!), entry.id).toBeGreaterThan(0);
    }
  });

  it('publishes seller-owned marketplace apps with pinned official icons and only implemented risk lanes', async () => {
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const expected = [
      ['shopee', 'shopee', 'https://open.shopee.com/favicon.ico', '8c8d19147f7b2ff2adc16e2198c1fb32d81eacf704c495eecb1ebbbc6c9ead79', 'b5405215bb8f4b34b8e0a8cb2d720be384520e97a42746a13087ce15a29488a9', ['partner_id', 'partner_key']],
      ['tiktok-shop', 'tiktok_shop', 'https://lf16-cdn-tos.tiktokcdn-us.com/obj/static-tx/i18n/ecom/TTS/normal/tts.ico', '32d05bd2db26d8b0155a349bd0fffc3419c89a4a59459b11b3d316ebfb3bc8ea', '6c50ace0f61a32afc48197bb505cff4ca98122e59c84aafff5eee09d0ae7f541', ['service_id', 'app_key', 'app_secret']],
    ] as const;
    const tools = ['list_capabilities', 'describe_action', 'execute_read', 'execute_high_impact'];
    for (const [id, provider, source, sourceHash, svgHash, credentials] of expected) {
      const entry = findCatalogEntry(id)!;
      expect(entry).toMatchObject({ auth_mode: 'local_api', category: 'commerce',
        local_api: { provider }, connection_setup: { requirement: 'provider_application' },
        icon_source_url: source, icon_source_sha256: sourceHash, allowed_tools: tools });
      expect(createHash('sha256').update(entry.icon_svg!).digest('hex')).toBe(svgHash);
      expect(Object.keys(entry.tool_policies!).sort()).toEqual([...tools].sort());
      expect(entry.tool_policies!.execute_high_impact).toMatchObject({ risk: 'H', confirmation: 'fresh' });
      expect(entry.connection_setup!.fields).toHaveLength(id === 'shopee' ? 4 : 5);
      expect(entry.connection_setup!.fields.filter((field) => field.storage === 'credential').map((field) => field.key))
        .toEqual(credentials);
      expect(entry.connection_setup!.callback_url).toBe('https://orkas.ai/api/connectors/oauth/dcr-callback');
      for (const instructions of [entry.connection_setup!.instructions_en, entry.connection_setup!.instructions_zh]) {
        expect(instructions).not.toContain(entry.connection_setup!.callback_url);
      }
      if (id === 'shopee') expect(entry.connection_setup!.fields.map(field => field.key))
        .toEqual(['region', 'shop_id', 'partner_id', 'partner_key']);
      expect(entry.connection_setup!.fields.map((field) => field.key)).not.toContain('shop_cipher');
    }
  });

  it('includes the direct commerce BYOA/BYOK batch with real artwork and device-only credential fields', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const direct = await import('../../../../src/main/features/connectors/catalog-direct-commerce');
    const expected = [
      ['commerce-layer', 'Commerce Layer', 'commerce_layer', 'https://logos.composio.dev/api/commerce_layer', 'a50211024021b52b9785cbf29bf66142c969cd64ceb28c71f4548673a9c72235', 'ba27e329067e611860a278ff48cc30a1f03fd82edd90bd2d3f6f990e959c27a3'],
      ['shopify-admin', 'Shopify Admin', 'shopify', 'https://logos.composio.dev/api/shopify', '5742f66b2b0f0eb4d5bcaa958ce4517d569f8699196bc08639db1bc1c4980481', '76f322d4790d613ada8c909ffa349b23be7009cc4e9cf26ef6b0d981a77f53ed'],
      ['constant-contact', 'Constant Contact', 'constant_contact', 'https://logos.composio.dev/api/constant_contact', 'd0a1c16fe82b534f6aacef072df4bb578661153a6db3e2cce4cd7855edde38da', 'b7091e0974ba221bd5e9a906fd170cd0aab7d6a55f0c7f135968036ce16a9d5d'],
      ['lightspeed-x', 'Lightspeed Retail X-Series', 'lightspeed', 'https://logos.composio.dev/api/lightspeed', '58407a93ca989628b9dc9c4e7c621daca5dbb43b514e6813c5ff11d3a59040c0', '33ffb4e554ee0dce4e4b45e374dc3a544e331fabf43acca4d5746900b2534cef'],
      ['square', 'Square', 'square', 'https://logos.composio.dev/api/square', 'e419920e75ea7be17b0e4ba6fd0a2e9065fbc7588e34412e013d58d9258ff77c', 'eccfaa6d2a8e238b9bf13d42b1283dc3b2bdb8b397a18d8af3ed6ef076444a81'],
      ['instacart-shopping', 'Instacart Shopping', 'instacart', 'https://logos.composio.dev/api/instacart', 'd2a24f1a65535c85ebae2c1fe963d0add66032b133b3b5667b63264170d8bd8e', '9822f762cab9e8100ee10bcd3995e5f3d527dd766ecf34cb6a827ceb06cbfd5a'],
      ['reloadly', 'Reloadly', 'reloadly', 'https://logos.composio.dev/api/reloadly', '819dfc49bcfc50069855373d2562ccf92caefc340e59010e2fa4d2452f589980', '4300ca0dcaa4eff347c5f731f8a2c3ffd03b1bd174e68740c65c3f3a500728d6'],
      ['woocommerce', 'WooCommerce', 'woocommerce', 'https://woocommerce.com/wp-content/uploads/2025/01/woo-logos.zip', 'a59ff90335d8ca3d13b53b93630445a8aba3e187869245adad80c3ac52628842', '470bb34f1d1fe8786d0ff85106d12c4b390c13cbd2ab783f16d3c68a655fc199'],
      ['walmart-marketplace', 'Walmart Marketplace', 'walmart', 'https://brandcenter.walmart.com/content/brand/us/en/home/brand-identity/spark/_jcr_content/root/container/side_rail/side_rail_right/block_container_1611011839/block_container_1641/block_container/columns/column_2/block_container/image.coreimg.svg/1736219744107/spark.svg', '9f8231afe91fb3127012c9c24cbb909e6d7f818adbb55cd0b9b42e427ba2a639', '9dcd0760e9e0179b39e9e15019fe1d81fffd8bdffd273dcf2fe386189786f459'],
      ['ebay-seller', 'eBay Seller', 'ebay', 'https://raw.githubusercontent.com/eBay/evo-web/main/packages/skin/src/svg/icon/icon-ebay-logo-16-colored.svg', '8f3fa022bc3473955bdec8d5df77cf796ee9bab5bbd20f907b0c66322152fa35', 'a1b80a2f8999fd9f4133e1fff7023413cf5c696974b2cad9c3c5fcca1dd6a6ad'],
      ['etsy-seller', 'Etsy Seller', 'etsy', 'https://extfiles.etsy.com/Press/brand-assets/etsy-logos.zip', 'a371bd03d03b3e44b69d8b43e1dce3fb0560a3c7a40a5371afee7126d5db59e1', '1fa5b6c27a2789b6cbe8d803309dbdf26c2b6f7144be2a6abbb24c38f3b7939d'],
      ['amazon-seller-central', 'Amazon Seller Central', 'amazon_seller', 'https://m.media-amazon.com/images/G/01/sell/navigation/amazon-logo-squid-menu.svg', '96038972ba58d1017a9af408b95ced924c903221b7450bf4d64e7d715ae5fe39', 'e48fd1a8ae2be2e70ffc38bb4232bb97d7b96d27c58c0c616aaccfd5dfd359c1'],
      ['mercado-libre-global-selling', 'Mercado Libre Global Selling', 'mercado_libre', 'https://http2.mlstatic.com/frontend-assets/ml-web-navigation/ui-navigation/5.21.22/mercadolibre/favicon.svg', 'bb35b84df3737ebb9f2449ce08e87c9efddfc810f1d3466bb67c251f97d6d4eb', '36ee428bb38ecfae06db166983518265b0028f047b8cb986b193eb8f7364f904'],
    ] as const;

    for (const [id, displayName, provider, sourceUrl, sourceHash, inlineHash] of expected) {
      const entry = catalog.findCatalogEntry(id);
      expect(entry).toMatchObject({
        id,
        display_name: displayName,
        category: 'commerce',
        auth_mode: 'local_api',
        local_api: { provider },
        transport_template: {
          kind: 'stdio',
          command: '${ORKAS_NODE}',
          args: ['${ORKAS_PC_DIR}/bin/direct-commerce-mcp-server.cjs'],
        },
        icon_source_url: sourceUrl,
        icon_source_sha256: sourceHash,
      });
      const expectedTools = [...direct.DIRECT_COMMERCE_TOOLS];
      expect(entry?.allowed_tools).toEqual(expectedTools);
      expect(Object.keys(entry?.tool_policies || {}).sort()).toEqual(
        expectedTools.sort(),
      );
      expect(entry?.tool_policies?.execute_read).toMatchObject({ risk: 'R', confirmation: 'none' });
      {
        expect(entry?.tool_policies).toMatchObject({
          execute_write: { risk: 'W', confirmation: 'preview' },
          execute_high_impact: { risk: 'H', confirmation: 'fresh' },
          execute_destructive: { risk: 'D', confirmation: 'destructive' },
        });
      }
      expect(entry?.icon_svg).toMatch(/^<svg(?:\s|>)/i);
      expect(entry?.icon_svg).toContain('width="100%"');
      expect(entry?.icon_svg).toContain('height="100%"');
      expect(entry?.icon_svg).not.toMatch(/<(?:script|foreignObject|iframe|image|use)\b/i);
      expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(inlineHash);
      expect(entry?.connection_setup?.fields.filter((field) => field.storage === 'credential').length)
        .toBeGreaterThan(0);
    }

    const setupHeavyIds = [
      'shopee',
      'tiktok-shop',
      'bigcommerce', 'shopline', 'shoplazza',
      'magento', 'temu-seller', 'lazada-seller', 'shein-seller', 'alibaba-com-seller', 'aliexpress-seller',
      'commerce-layer',
      'shopify-admin',
      'constant-contact',
      'ebay-seller',
      'etsy-seller',
      'amazon-seller-central',
      'mercado-libre-global-selling',
      'taobao-tmall-seller', 'alibaba-1688-seller', 'jd-seller', 'pinduoduo-seller',
      'douyin-shop-seller', 'kuaishou-shop-seller', 'youzan-seller', 'weimob-wos-seller', 'xiaohongshu-seller',
    ];
    expect(direct.DIRECT_COMMERCE_ENTRIES
      .filter((entry) => entry.connection_setup?.requirement)
      .map((entry) => entry.id)).toEqual(setupHeavyIds);
    for (const id of setupHeavyIds) {
      expect(catalog.findCatalogEntry(id)?.connection_setup).toMatchObject({
        requirement: id === 'douyin-shop-seller' ? 'business_qualification' : 'provider_application',
      });
    }
    for (const id of setupHeavyIds) {
      expect(catalog.findCatalogEntry(id)?.connection_setup).toMatchObject({
        instructions_zh: expect.any(String),
        instructions_en: expect.any(String),
        guide_url: expect.stringMatching(/^https:\/\//),
        guide_label_zh: expect.any(String),
        guide_label_en: expect.any(String),
      });
    }

    expect(catalog.findCatalogEntry('shopify-admin')?.connection_setup?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'shop_domain', storage: 'metadata' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
      ]));
    expect(catalog.findCatalogEntry('commerce-layer')).toMatchObject({
      local_api: { provider: 'commerce_layer' },
      connection_setup: {
        guide_url: 'https://docs.commercelayer.io/core/api-credentials',
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'organization_slug', storage: 'metadata', format: 'commerce_layer_slug' }),
          expect.objectContaining({ key: 'client_id', storage: 'credential' }),
          expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
        ]),
      },
    });
    expect(catalog.findCatalogEntry('commerce-layer')?.requires_credits).toBeUndefined();
    expect(catalog.findCatalogEntry('constant-contact')?.connection_setup?.fields)
      .toEqual([expect.objectContaining({ key: 'client_id', storage: 'credential' })]);
    expect(catalog.findCatalogEntry('reloadly')?.connection_setup?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'product', input: 'choice', storage: 'metadata' }),
      ]));
    expect(catalog.findCatalogEntry('square')?.connection_setup?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'access_token', input: 'secret', storage: 'credential' }),
      ]));
    expect(catalog.findCatalogEntry('instacart-shopping')).toMatchObject({
      description_en: expect.stringContaining('merchant orders and inventory are not available'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'api_key', input: 'secret', storage: 'credential', format: 'instacart_api_key' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('woocommerce')).toMatchObject({
      description_en: expect.stringContaining('Read/Write REST API key'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'store_url', storage: 'metadata', format: 'woocommerce_store_url' }),
        expect.objectContaining({ key: 'consumer_key', storage: 'credential', format: 'woocommerce_consumer_key' }),
        expect.objectContaining({ key: 'consumer_secret', input: 'secret', storage: 'credential', format: 'woocommerce_consumer_secret' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('walmart-marketplace')).toMatchObject({
      description_en: expect.stringContaining('approved seller account'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'market', storage: 'metadata', format: 'walmart_market' }),
        expect.objectContaining({ key: 'client_id', storage: 'credential' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('ebay-seller')).toMatchObject({
      description_en: expect.stringContaining('official OAuth'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'marketplace_id', storage: 'metadata', format: 'ebay_marketplace' }),
        expect.objectContaining({ key: 'content_language', storage: 'metadata', format: 'ebay_content_language' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
        expect.objectContaining({ key: 'ru_name', storage: 'credential', format: 'ebay_ru_name' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('etsy-seller')).toMatchObject({
      description_en: expect.stringContaining('Seller API Access'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'shop_id', storage: 'metadata', format: 'etsy_shop_id' }),
        expect.objectContaining({ key: 'keystring', storage: 'credential', format: 'etsy_keystring' }),
        expect.objectContaining({ key: 'shared_secret', input: 'secret', storage: 'credential' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('amazon-seller-central')).toMatchObject({
      description_en: expect.stringContaining('Buyer PII and RDT operations are not requested'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'marketplace_id', storage: 'metadata', format: 'amazon_marketplace' }),
        expect.objectContaining({ key: 'seller_id', storage: 'metadata', format: 'amazon_seller_id' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
        expect.objectContaining({ key: 'refresh_token', input: 'secret', storage: 'credential', format: 'amazon_refresh_token' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('amazon-seller-central')?.connection_setup?.fields
      .find((field) => field.key === 'marketplace_id')?.options).toHaveLength(23);
    expect(catalog.findCatalogEntry('mercado-libre-global-selling')).toMatchObject({
      description_en: expect.stringContaining('official OAuth with PKCE'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'user_id', storage: 'metadata', format: 'mercado_libre_user_id' }),
        expect.objectContaining({ key: 'client_id', storage: 'credential' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
      ]) },
    });
    for (const id of [
      'taobao-tmall-seller',
      'alibaba-1688-seller',
      'jd-seller',
      'pinduoduo-seller',
      'douyin-shop-seller',
      'kuaishou-shop-seller',
      'youzan-seller',
      'weimob-wos-seller',
      'xiaohongshu-seller',
    ]) {
      expect(catalog.findCatalogEntry(id), id).toMatchObject({ auth_mode: 'local_api' });
    }

  });

  it('includes the first official remote commerce MCP batch with pinned policy and artwork', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');

    const klaviyo = catalog.findCatalogEntry('klaviyo');
    expect(klaviyo).toMatchObject({
      id: 'klaviyo',
      display_name: 'Klaviyo',
      icon_source_url: 'https://logos.composio.dev/api/klaviyo',
      icon_source_sha256: '655fc42ba08b624ac572e7abde18bb655c0485b64d675a2c68cf799f48f06ff1',
      category: 'commerce',
      auth_mode: 'mcp_dcr',
      transport_template: {
        kind: 'streamable-http',
        oauth_header_key: 'Authorization',
      },
    });
    const klaviyoUrl = new URL(String(
      klaviyo?.transport_template?.kind === 'streamable-http'
        ? klaviyo.transport_template.url
        : '',
    ));
    expect(`${klaviyoUrl.origin}${klaviyoUrl.pathname}`).toBe('https://mcp.klaviyo.com/mcp');
    expect(klaviyoUrl.searchParams.get('read-only')).toBe('false');
    expect(klaviyoUrl.searchParams.get('beta')).toBe('false');
    expect(klaviyoUrl.searchParams.get('toolsets')).toContain('campaigns:write');
    expect(klaviyoUrl.searchParams.get('toolsets')).toContain('profiles:write');
    expect(klaviyo?.allowed_tools).toHaveLength(178);
    expect(klaviyo?.allowed_tools).toEqual(expect.arrayContaining([
      'get_account_details',
      'create_campaign',
      'send_campaign',
      'create_catalog_item',
      'subscribe_profile_to_marketing',
    ]));
    expect(klaviyo?.allowed_tools).not.toContain('request_profile_deletion');
    expect(klaviyo?.allowed_tools).not.toContain('update_review');
    expect(Object.keys(klaviyo?.tool_policies || {}).sort()).toEqual(
      [...(klaviyo?.allowed_tools || [])].sort(),
    );
    expect(klaviyo?.tool_policies).toMatchObject({
      get_account_details: { risk: 'R', confirmation: 'none' },
      create_campaign: { risk: 'W', confirmation: 'preview' },
      send_campaign: {
        risk: 'H', confirmation: 'fresh', sensitive_operation: 'external_communication',
      },
      bulk_import_profiles: {
        risk: 'H', confirmation: 'fresh', sensitive_operation: 'bulk_or_automation',
      },
      delete_campaign: { risk: 'D', confirmation: 'destructive' },
    });

    const paypal = catalog.findCatalogEntry('paypal');
    expect(paypal).toMatchObject({
      id: 'paypal',
      display_name: 'PayPal',
      icon_source_url: 'https://logos.composio.dev/api/paypal',
      icon_source_sha256: '50e3507dd5a6f972890113084eea453a7b0e7d02c720dc92970e8fb5ac7016c2',
      category: 'commerce',
      auth_mode: 'mcp_dcr',
      transport_template: {
        kind: 'streamable-http',
        url: 'https://mcp.paypal.com/http',
        oauth_header_key: 'Authorization',
      },
    });
    expect(paypal?.allowed_tools).toHaveLength(30);
    expect(paypal?.allowed_tools).toEqual(expect.arrayContaining([
      'create_invoice',
      'pay_order',
      'create_refund',
      'accept_dispute_claim',
      'cancel_subscription',
    ]));
    expect(Object.keys(paypal?.tool_policies || {}).sort()).toEqual(
      [...(paypal?.allowed_tools || [])].sort(),
    );
    expect(paypal?.tool_policies).toMatchObject({
      list_transactions: { risk: 'R', confirmation: 'none' },
      create_invoice: { risk: 'W', confirmation: 'preview' },
      create_refund: { risk: 'H', confirmation: 'fresh', sensitive_operation: 'money' },
      create_shipment_tracking: {
        risk: 'H', confirmation: 'fresh', sensitive_operation: 'fulfillment',
      },
      cancel_subscription: { risk: 'D', confirmation: 'destructive' },
    });
    expect(paypal?.connection_variants).toBeUndefined();
    const paypalSandbox = catalog.findCatalogEntry('paypal-sandbox');
    expect(paypalSandbox).toMatchObject({
      display_name: 'PayPal Sandbox',
      icon_source_url: 'https://logos.composio.dev/api/paypal',
      icon_source_sha256: '50e3507dd5a6f972890113084eea453a7b0e7d02c720dc92970e8fb5ac7016c2',
      catalog_parent_id: 'paypal',
      auth_mode: 'mcp_dcr',
      transport_template: {
        kind: 'streamable-http',
        url: 'https://mcp.sandbox.paypal.com/http',
      },
    });
    expect(paypalSandbox?.allowed_tools).toEqual(paypal?.allowed_tools);
    expect(paypalSandbox?.tool_policies).toEqual(paypal?.tool_policies);

    const netsuite = catalog.findCatalogEntry('netsuite');
    expect(netsuite).toMatchObject({
      display_name: 'Oracle NetSuite',
      icon_source_url: 'https://logos.composio.dev/api/netsuite',
      icon_source_sha256: '7eba8c219e9eca1f62a6f3e6309041630a2dba869d07491c3d83e27f18d1efb5',
      category: 'commerce',
      auth_mode: 'mcp_dcr',
      connection_setup: {
        fields: [{ key: 'account_id', format: 'netsuite_account_id', required: true }],
      },
      transport_template: {
        kind: 'streamable-http',
        url: 'https://{{account_id}}.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools',
      },
    });
    expect(netsuite?.allowed_tools).toHaveLength(14);
    expect(netsuite?.allowed_tools).toEqual(expect.arrayContaining([
      'ns_createRecord',
      'ns_updateRecord',
      'ns_runReport',
      'ns_runSavedSearch',
      'ns_runCustomSuiteQL',
    ]));
    expect(netsuite?.transport_template?.kind === 'streamable-http'
      ? netsuite.transport_template.url
      : '').not.toContain('/all');
    expect(Object.keys(netsuite?.tool_policies || {}).sort()).toEqual(
      [...(netsuite?.allowed_tools || [])].sort(),
    );
    expect(netsuite?.tool_policies).toMatchObject({
      ns_getRecord: { risk: 'R', confirmation: 'none' },
      ns_runCustomSuiteQL: { risk: 'R', confirmation: 'none' },
      ns_createRecord: {
        risk: 'H', confirmation: 'fresh', sensitive_operation: 'business_record', max_batch_size: 1,
      },
      ns_updateRecord: {
        risk: 'H', confirmation: 'fresh', sensitive_operation: 'business_record', max_batch_size: 1,
      },
    });
    const policyHash = (entry: typeof klaviyo): string => {
      const sorted = Object.fromEntries(
        Object.entries(entry?.tool_policies || {}).sort(([a], [b]) => a.localeCompare(b)),
      );
      return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
    };
    expect(policyHash(klaviyo)).toBe('594e57c7b0db79d1b027bd44dfa79bdbff7c8ac37a780cb11da9792c4f67a01b');
    expect(policyHash(paypal)).toBe('e89b829d33d7f1dae254bf427a62fe2b1a60eca348fe40ea3476f86da7efc9b6');

    for (const [entry, hash] of [
      [klaviyo, '482faf16fa2b3b994b189126789c060c271491df4b1f473ff85917fa092ccc92'],
      [paypal, '9cdeee7be7d027533f4ce5e61b36618c4c3fa81296aa31fdfc3b648963341bdf'],
      [paypalSandbox, '9cdeee7be7d027533f4ce5e61b36618c4c3fa81296aa31fdfc3b648963341bdf'],
      [netsuite, 'b10575b5f745ac930588e96cd3d9694f0aca7ed82654e2f10c954d13442c249d'],
    ] as const) {
      expect(entry?.icon_svg).toMatch(/^<svg(?:\s|>)/i);
      expect(entry?.icon_svg).toContain('width="100%"');
      expect(entry?.icon_svg).toContain('height="100%"');
      expect(entry?.icon_svg).not.toMatch(/<(?:script|foreignObject|iframe|image|use)\b/i);
      expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(hash);
    }
  });

  it('includes Google Search Console as an independent built-in server-bridge connector', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');

    expect(catalog.findCatalogEntry('gsearch-console')).toMatchObject({
      id: 'gsearch-console',
      display_name: 'Google Search Console',
      category: 'data',
      auth_mode: 'server_bridge',
      oauth: { provider_id: 'google' },
      required_oauth_scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      transport_template: {
        kind: 'stdio',
        command: '${ORKAS_NODE}',
        args: ['${ORKAS_PC_DIR}/bin/gsearch-console-mcp-server.cjs'],
        oauth_env_key: 'GOOGLE_ACCESS_TOKEN',
      },
    });
  });

  it('includes released Composio workspace connectors in the public built-in catalog', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const legacy = await import('../../../../src/main/features/connectors/catalog-google');
    expect(legacy.GOOGLE_ENTRIES.some((entry) => entry.id === 'gmail')).toBe(false);
    expect(catalog.findCatalogEntry('gmail')?.oauth).toBeUndefined();

    const expected = [
      ['gmail', 'Gmail', 'communication'],
      ['outlook', 'Outlook', 'communication'],
      ['m365-mail', 'Microsoft 365 Mail', 'communication'],
      ['m365-calendar', 'Microsoft 365 Calendar', 'productivity'],
      ['onedrive', 'OneDrive', 'productivity'],
    ];

    for (const [id, displayName, category] of expected) {
      expect(catalog.findCatalogEntry(id)).toMatchObject({
        id,
        display_name: displayName,
        category,
        requires_credits: true,
        auth_mode: 'composio',
        transport_template: null,
        usage_metering: {
          provider: 'composio',
          credits_milli_per_call: id === 'gmail' ? 250 : 420,
        },
      });
    }
  });

  it('includes the released commerce connectors with pinned official SVG artwork', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const expected = [
      ['baselinker', 'BaseLinker', '8a96d579f5c69b8c9d97a42aa8e97cdb71309769fec1dace00150102816e0455', 'https://logos.composio.dev/api/baselinker', 'fb52d258530b401dffb0015eb3d7131a76ac85c86aabe6a1c7df73267f0ec6e8'],
      ['order-desk', 'Order Desk', 'e99019beb87aa95d888fd27698f2e30553ce0b64280e59ada0bf9a564626a513', 'https://logos.composio.dev/api/order_desk', '8b0495a7da066379a73d96a602dfd70c5c57ae290795fe1e14aa065def104d28'],
      ['printify', 'Printify', '15514b0fbc1458f46cd165dfedcb2173847b4b4901cb272466b7afe1168f0dda', 'https://logos.composio.dev/api/printify', 'bd48fc5c179844fd33697b2c83354947893cf0ec282dcc41fec2df0fadf01f3f'],
      ['shipengine', 'ShipEngine', 'f97c47cadff43d2378da2889e32e9a871c10e71bc06f9451b8ce947cd924a7b7', 'https://logos.composio.dev/api/shipengine', '3fc335bc27eac40aab9f4654b8b3d146ab62b8c3bf96dc39cee67a2b366653d6'],
      ['shippo', 'Shippo', '3b0e815faae1439c35a005a7a5f42bbb1f894da6cc5c8803eaa12c579a49134f', 'https://logos.composio.dev/api/shippo', '050bc63a955e8cc1dea7f51086498b5e8c8d610df4dd065f6aeb8373f1adb94f'],
      ['gorgias', 'Gorgias', '155ac4005f38d1b3a209d131575c0cb89a5a86bccd54b88ffbe22c1293a761b7', 'https://logos.composio.dev/api/gorgias', '2b13b2ef00b49bf8acd341c715ebf4a20808f7f528fbfb738e41f93bae054a29'],
      ['gumroad', 'Gumroad', 'f1c668454ae19b3676dd98315ecf605f4dd24e40a9c64940da37df3c38061dee', 'https://logos.composio.dev/api/gumroad', '69f40bdf04b7b08a57ad9a1e4256278dc553dc099d9bc7992a8999fe158fe323'],
      ['lemon-squeezy', 'Lemon Squeezy', 'a3a9200874fe5a3279e49b4f89b6a9e8b1abc25730bc3c75367a7708ceefc498', 'https://logos.composio.dev/api/lemon_squeezy', 'bfb4663c7b5a63662789d74e052d8ce4f0b157d66e22fe3ae317921ae0894da7'],
      ['loyverse', 'Loyverse', 'cdbf148663c2cbc70531519581da494886c88ebf89ab990aee93d1d973179e46', 'https://logos.composio.dev/api/loyverse', '5779169b8c50bb1b5e74fb2c7af60a1e81aa5d6f9cc1f13ae3132354bf3b8ad8'],
      ['gelato', 'Gelato', '6b8e233237440aeb410c30f35f5422e337e53fa7c1ce8f81693ecf862d7b51c2', 'https://logos.composio.dev/api/gelato', '8c3e32cdc4e957914b501e5f7c39fbb2a74646545e32d6d495707e81b9822113'],
      ['gift-up', 'Gift Up', '633182c6acd38649ae074eb954cb8b1761e5d0c5fecdb057d19e4bf77de19ebe', 'https://logos.composio.dev/api/gift_up', '49baa94b2ad0eb79b381d00a7fa73f1e40b4a370f0f6ed41066d190fd4d0b33f'],
      ['goody', 'Goody', '7cb104678bbb6490c2be4496f6cd36beed9512a65af406350ef721731166981d', 'https://logos.composio.dev/api/goody', '6de5e783d967ba2aaab7adda9f55ea4db91786cc66f5b92855ea2af6015784a8'],
      ['starshipit', 'Starshipit', '30d9bbc99fd8557f64a55c2345526bcc8976ce7360ed9e09d308a9a09134483c', 'https://logos.composio.dev/api/starshipit', '974018689b9226f2dc88be80cdcc25cd0035610cbf096e371611b40b14f9ec40'],
      ['fraudlabs-pro', 'FraudLabs Pro', '8db085f0b2135644a3a5590a73cdfc4b529d64fcde11f694c370296b2b716e0b', 'https://logos.composio.dev/api/fraudlabs_pro', '58bf5373a82f2192ac6682f92b462226195c7fdd81745a2fc4fdf29014647be4'],
      ['cloudcart', 'CloudCart', 'a258d9cba915aba76719f034d12c80677cedbad3279faf86a61f7fb52ddb762e', 'https://logos.composio.dev/api/cloudcart', 'e39950ce04d0c085c02b47645f4cc5e61d4546778ca3674ae20c5837a0591b56'],
      ['memberstack', 'Memberstack', 'ba0aa39c03393582f870244be7f36899f66f050ecf0928bc994c0828eb0039cf', 'https://logos.composio.dev/api/memberstack', 'e4f38013eabf700f9da6cbd8bff38755d0ffca7ebcb8000006bb9d8b57cabe26'],
      ['finerworks', 'FinerWorks', '094f7a8ad05c950239d7a0a48b2918e99b92ae39d11fea7beb80ed340ee08eed', 'https://logos.composio.dev/api/finerworks', '28591254b34a3dcd56b1fd8d8a744fe808dbf27b5ebe2a3aca953d7fa2addfbc'],
      ['shipday', 'Shipday', '4e8504670a511d064134864aa34d4f1de8307db3898348408fe1d6a52c92cec9', 'https://logos.composio.dev/api/shipday', 'c823972b9de39895c4a7d8808d0eb52976ef6f59dab5c305f0d4fb9e6e18b162'],
      ['btcpay-server', 'BTCPay Server', '994b5f5c5f673f1f719c84c009dde56023276c7dd4da0343957dc2b6e37b8b77', 'https://logos.composio.dev/api/btcpay_server', 'ab56aa5a702ed46ab049c6ec63c6ce454d1280b3c232973f478c4c2e37f6a080'],
      ['quaderno', 'Quaderno', 'bce475d0a30f5e9e8d0c95957ab8c42e828b95fd90a5ca3b34f8633c575f7062', 'https://logos.composio.dev/api/quaderno', '1a826b7eb52a1bb56282c68d8cb0213f74e2e09e3f5860b450f2caf3778c5da6'],
      ['intercom', 'Intercom', 'cb3ccc049466ca1e7a8445cd86726bd2cba190fbacab96bf9dc776ff1fd3e8b5', 'https://logos.composio.dev/api/intercom', '0bb278f014a634dc4ec316f755efbb1d469e156b5e9c4f8089e97512ecb914a1'],
      ['mailchimp', 'Mailchimp', '7b3134e8557706abec643ae627f2653a0138296d98d1165431e0f1b1eee3711f', 'https://logos.composio.dev/api/mailchimp', 'e06abba45c05e39d1b6bafb0937a7064cd7a1ab06cb086b868fc8c73984a7893'],
      ['quickbooks', 'QuickBooks', 'b9564b006aa81f40a55b70a95991fb5c64ef440988a2782dca02cb790dff86a5', 'https://logos.composio.dev/api/quickbooks', '487a384962e391463e09e63675fca1c101d7c556fbce2a41a03f7a367f6147ef'],
      ['hubspot', 'HubSpot', '5d81a8c550cabd9c89bba87af2fde0feb01fde0067655db3d6c3d26ebd4d1aaa', 'https://logos.composio.dev/api/hubspot', '14ecd8400dd658af99222112ad0c6e675c38dc249290e484a690a4dc35cd793d'],
      ['google-ads', 'Google Ads', '591af88be72c1385350191ff81abf0bb8e1c8597ef196fce0086b5b7176c9a00', 'https://logos.composio.dev/api/googleads', '667211fbddd1c23102c59da1853b06886fe6bf2e197b0109a157fe61300d1e69'],
      ['facebook', 'Facebook', '84c16030bda94d17cf1af7b8076fd72354ab83349f47d8e22d90598d53bfe846', 'https://logos.composio.dev/api/facebook', 'abae038dca9b019a3daec5aaab01992e157b3e6c0272d95cd56d959e6678fc66'],
      ['zendesk', 'Zendesk', '345e3a02c06fafc9337e3a41dc1c8becb8e98f54c09824f2b7f308d8f683578a', 'https://logos.composio.dev/api/zendesk', '8b7061e008f84b7c6bb1aa1e88d20b65c1a8a1d7241c56820e6109baa9e2abc8'],
      ['google-analytics', 'Google Analytics', 'ce28304900cf8352d09e36b1245e7f6ddd99f276504281d69cfd0a26d1c61a97', 'https://logos.composio.dev/api/google_analytics', '924f3ec346524a6ad2ffa060c870f8e721806df28883a4c494114f6de6be0925'],
      ['salesforce', 'Salesforce', '001b8f4069c86de59050fbaea51847250741088a66ab1716a78771352a0d7256', 'https://logos.composio.dev/api/salesforce', 'b8d14f2b18d4984abeaec61a49b2bf4fbf63bbf39879d55035ce6f55d0c76c39'],
      ['pinterest', 'Pinterest', 'c37d26cb372f2a6934b7b874496312d93f97f4c90ba64856f1e1c18ff4d92d69', 'https://logos.composio.dev/api/pinterest', '04417ffd313e7ebbc2357cfbe11c82fd2cb409bd0c2098ef8a7f5ac45ea5d2b2'],
      ['active-campaign', 'ActiveCampaign', 'f6c71d4ba9c1db5e610d6b0154ecfc2723988c919d0c4336bcea03be433f3a1b', 'https://logos.composio.dev/api/active_campaign', 'f032ab47c15c5ee4a8b279ec1ad8e11813917734392fd8e741af69b61ec866e9'],
      ['customer-io', 'Customer.io', '10ac772e47509f0f62f23a92ca92797e4fe6cb5b54576136b2edaf2c9590941c', 'https://logos.composio.dev/api/customerio', '979e1c9c96254f2967a2ad0f47cc6b4b79a6ac43f9ca34f9d933f5738941efa2'],
      ['kit', 'Kit', 'b139ea2ed5e437655270e1d67ef948c0320af62f77a184de7d009e6406679150', 'https://logos.composio.dev/api/kit', 'f74e6c044e441842a73f9ae44c9b0849be758a74e00f50fb4c82f61ba4b7f794'],
      ['segment', 'Segment', 'a829692607ee001d6ebabd66f2e4da99f91373359d91e798a07cedcd59aee115', 'https://logos.composio.dev/api/segment', 'b258842a4ec10f20aff78dda8980cec21bdb09e74661f5d25415726193746e36'],
      ['sendgrid', 'SendGrid', '0a18f672bbbb9b720b85e3b3ee4effeda0fe72a991c007bcbf97352246c8e1ee', 'https://logos.composio.dev/api/sendgrid', '7f289c0b8d12acdd616b74dcbe726113ea40234b95f509a5ef5980889950f3f0'],
      ['wix', 'Wix', '364358a6e78d57363cb3e972a50b62c246f2363b5d418a7dfc426285caa5e9e4', 'https://logos.composio.dev/api/wix', 'bec7a84da723f2b62d213aeb56371bf374254df7ae610db968900c1b6c70d47d'],
      ["fingertip", "Fingertip", "f4b878c8769f765214d59964bad61f7a3cf915201d812a9a83b355bda0cd1321", 'https://logos.composio.dev/api/fingertip', '8afecc690f22befda8f61cba38be9874a542abb6328c02bc69798e7dca4982f3'],
      ["merchantpro", "MerchantPro", "5a8e44de46241c4c7270b9d582d7021bb0ea697d8291b27af29cd494012fee3d", 'https://logos.composio.dev/api/merchantpro', '07691c5b760f81d64a87747ba647c675b87fdb9ebf21fd3b19596072803bf208'],
      ["payhip", "Payhip", "315c086abc5f5cf19a781b2d0223db255c71371835923e9a170e89b8c93cecf5", 'https://logos.composio.dev/api/payhip', 'bef1084783c7a2d31d87ce04578b4a73f19ae3f20546f3f621e00f3c4b54ee19'],
      ["zylvie", "Zylvie", "ca5f05f8942b09f5e992ad02aa1e576b57d154aec884c9d9f22b1ca8d7f8f447", 'https://logos.composio.dev/api/zylvie', 'f7f5efc9424fea12d472e3d3f462a02cbe7691a10862457a8a169b8a4887b9c6'],
      ["dpd2", "DPD", "23109f4d21db91f2270d44c3da5e534e3a5c8d61bef23b49301fb83796e7b4c0", 'https://logos.composio.dev/api/dpd2', '5b167931b322e939703e6cf43e0d370025f69aa01a01260ad2faa39e32c95257'],
      ["addresszen", "Addresszen", "a49f6e49afd06a43e3a5dd4134f26306af1714d315cad0b7bad5fc12636367d2", 'https://addresszen.com/favicon.svg', '7a20443f855d74b00e3f081bff774b1fbae7a652673802f4827859209a184c02'],
      ["bluebarry", "Bluebarry", "bdaa5790a632787ba3402c4accc21b7d1967b76b67642107ebe6f5be2f2628ce", 'https://logos.composio.dev/api/bluebarry', '93d3610bf57cfba4d0f76cc2efa390ab715a08c866b5b7603b095db3067833ba'],
      ["hitpay", "HitPay", "9506f35de35c26663e957ce4cf2b58318d6f77466f61fa8a0d59346fc2047763", 'https://logos.composio.dev/api/hitpay', '502e9c247eb059e0426d65b12b439f4e30a5bd33c7c1ade396d4150918d2c939'],
      ["poof", "Poof", "cddd01b67087c5b9b0b0b137354fac88f638881c60e370be26af4b986f786fc6", 'https://logos.composio.dev/api/poof', '3d1d6d194923b4858046ac67a4ab643147ccf2291b4e6d9e77cec24dfac81693'],
      ["asin-data-api", "ASIN Data API", "cf3479f046c5c31fc5ff83b066c234060df0e2fcebcf2eba0cfab054cc24ffd8", 'https://logos.composio.dev/api/asin_data_api', '39c5055bb5393ade7418b71f2a07a8d74e9edbba9e023f846bb7a6b98db97528'],
      ["bestbuy", "Best Buy", "a213c9354ee613339b188747c4fb78098acc7b96c3c83f11f559cee8aca155c8", 'https://logos.composio.dev/api/bestbuy', '4a7ea66dd1b192522adffd7ca4c5aaaaf089652ae55db6d8f5c333f9945d8fcd'],
      ["countdown-api", "Countdown API", "d8d157fa198d20d4e2442995175b2b04267ec76b5b9e9fca8f323b791a5398c3", 'https://logos.composio.dev/api/countdown_api', '4628909fb14ff518e278d995d18636a1fc74ef21a4d87bcee9b864e1b9d89c26'],
      ["jungle-scout", "Jungle Scout", "085021fcdfadc8c5a7e61ad23c2c76d64f46438782e5941fc4a852ae9482630a", 'https://logos.composio.dev/api/junglescout', '68ca6e7de3c3acef3bd0f54bc040ecf36d3f16fa4b136ea9041e17d9135f89cf'],
      ["opensea", "OpenSea", "b1a4515e69661b0608601a2bc07d7ef344a0e36c54fe3063d0db9a50eaed2c6a", 'https://logos.composio.dev/api/open_sea', '0d86252f894acfc9f4f87d5b91a91ed4837af7488f8fb5810380f7b461fed7d0'],
      ["redcircle-api", "RedCircle API", "d8b004c740a8817818d90e80ee0b736ff35b0d1f9fb22db55d80712e5017920e", 'https://images.archbee.com/_2H-bV01Fa8fCx9qd5d88/I7Xk8nerwoPywicCeYMHW_redcircleapi-white.png', '93f1670d748750715966bfa55a8d67ceb01ef80d0fb7566fc9b541796981ce97'],
      ["retailed", "Retailed", "df4199dbf3a747cf1ce25a061569475055c1e7cebd29c1a07c5d9367fe090ca2", 'https://logos.composio.dev/api/retailed', '745c23c644342fef6faef1d1432aaff2def7bc24e1e67218c9898168eb0ad1d5'],
      ["cdr-platform", "CDR Platform", "eb6da66cb3da18bd002214db40d7a897f85ab2891d26080ae947b94fe0fd02c1", 'https://logos.composio.dev/api/cdr_platform', '4b06b7909ca9b174b85d82b0b6fa85b83d61846a1df530e81ad408d789172ef5'],
      ["taxjar", "TaxJar", "7e6fcc17b8f42d90764c9553f410627e02816a7283afc535a8e9a79b88580b81", 'https://logos.composio.dev/api/taxjar', 'ff3c653fa8bfd6124f752c989b85d645ef0a38a35e8b0932c0cbefd15dd6f4c4'],
    ];

    for (const [id, displayName, iconHash, iconSourceUrl, iconSourceSha256] of expected) {
      const entry = catalog.findCatalogEntry(id);
      expect(entry).toMatchObject({
        id,
        display_name: displayName,
        icon_source_url: iconSourceUrl,
        icon_source_sha256: iconSourceSha256,
        category: 'commerce',
        requires_credits: true,
        auth_mode: 'composio',
        transport_template: null,
        usage_metering: {
          provider: 'composio',
          credits_milli_per_call: 420,
        },
      });
      expect(entry?.icon_svg).toMatch(/^<svg(?:\s|>)/i);
      expect(entry?.icon_svg).toContain('width="100%"');
      expect(entry?.icon_svg).toContain('height="100%"');
      expect(entry?.icon_svg).not.toMatch(/<(?:script|foreignObject|iframe|image|use)\b/i);
      expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(iconHash);
    }
  });

  it('merges commerce runtime policy without replacing the pinned brand card', async () => {
    const users = await import('../../../../src/main/features/users');
    const { clientConfig } = await import('../../../../src/main/features/client_config');
    const catalog = await import('../../../../src/main/features/connectors/catalog');

    users.activateUser('catalogservercommerceoverride');
    clientConfig.applyServerPayload({
      immediate: {
        'connectors.catalog': [{
          id: 'baselinker',
          display_name: 'Fake BaseLinker',
          icon_svg: '<svg viewBox="0 0 1 1"></svg>',
          category: 'commerce',
          description_zh: '服务端文案不应覆盖内置卡片。',
          description_en: 'Server copy must not replace the bundled card.',
          auth_mode: 'composio',
          composio: {
            toolkit: 'baselinker',
            auth_config_id: 'ac_baselinker123456',
            tools: [{ slug: 'BASELINKER_GET_ORDERS' }],
          },
          transport_template: null,
          usage_metering: {
            provider: 'composio',
            credits_milli_per_call: 420,
          },
        }],
      },
      restart: {},
      config_hash: 'sha256:catalogservercommerceoverride',
    }, '"catalogservercommerceoverride"', 1000);

    const entry = catalog.findCatalogEntry('baselinker');
    expect(entry).toMatchObject({
      display_name: 'BaseLinker',
      category: 'commerce',
      composio: {
        toolkit: 'baselinker',
        auth_config_id: 'ac_baselinker123456',
        tools: [{ slug: 'BASELINKER_GET_ORDERS' }],
      },
    });
    expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(
      '8a96d579f5c69b8c9d97a42aa8e97cdb71309769fec1dace00150102816e0455',
    );
  });

  it('does not let stale Composio config replace the migrated Commerce Layer direct connector', async () => {
    const users = await import('../../../../src/main/features/users');
    const { clientConfig } = await import('../../../../src/main/features/client_config');
    const catalog = await import('../../../../src/main/features/connectors/catalog');

    users.activateUser('catalogcommercelayerdirect');
    clientConfig.applyServerPayload({
      immediate: {
        'connectors.catalog': [{
          id: 'commerce-layer', display_name: 'Commerce Layer', category: 'commerce',
          description_zh: '旧服务端配置', description_en: 'Stale server config',
          auth_mode: 'composio', composio: {
            toolkit: 'commerce_layer', auth_config_id: 'ac_stale_commerce_layer', tools: [],
          },
          requires_credits: true, transport_template: null,
          usage_metering: { provider: 'composio', credits_milli_per_call: 420 },
        }],
      },
      restart: {},
      config_hash: 'sha256:catalogcommercelayerdirect',
    }, '"catalogcommercelayerdirect"', 1000);

    expect(catalog.findCatalogEntry('commerce-layer')).toMatchObject({
      auth_mode: 'local_api',
      local_api: { provider: 'commerce_layer' },
      transport_template: { kind: 'stdio' },
    });
    expect(catalog.findCatalogEntry('commerce-layer')?.requires_credits).toBeUndefined();
    expect(catalog.findCatalogEntry('commerce-layer')?.composio).toBeUndefined();
  });

  it.each([250, 420, undefined])('merges the server Composio tariff %s into released built-in cards', async (tariff) => {
    const users = await import('../../../../src/main/features/users');
    const { clientConfig } = await import('../../../../src/main/features/client_config');
    const catalog = await import('../../../../src/main/features/connectors/catalog');

    users.activateUser('catalogservercomposiooverride');
    clientConfig.applyServerPayload({
      immediate: {
        'connectors.catalog': [
          {
            id: 'gmail',
            display_name: 'Server Docs',
            icon_svg: '<svg viewBox="0 0 1 1"></svg>',
            category: 'productivity',
            description_zh: '服务端展示文案不应覆盖 PC 内置卡片。',
            description_en: 'Server display copy should not override the bundled card.',
            requires_credits: false,
            auth_mode: 'composio',
            composio: {
              toolkit: 'gmail',
              auth_config_id: 'ac_docs123456',
              tools: [{ slug: 'GMAIL_FETCH_EMAILS' }],
            },
            transport_template: null,
            usage_metering: {
              provider: 'composio',
              credits_milli_per_call: tariff,
            },
          },
        ],
      },
      restart: {},
      config_hash: 'sha256:catalogservercomposiooverride',
    }, '"catalogservercomposiooverride"', 1000);

    expect(catalog.findCatalogEntry('gmail')).toMatchObject({
      id: 'gmail',
      display_name: 'Gmail',
      description_zh: '读 / 发邮件、整理收件箱。',
      auth_mode: 'composio',
      composio: {
        toolkit: 'gmail',
        auth_config_id: 'ac_docs123456',
      },
      usage_metering: {
        provider: 'composio',
        credits_milli_per_call: tariff ?? 420,
      },
      requires_credits: true,
      transport_template: null,
    });
  });
});
