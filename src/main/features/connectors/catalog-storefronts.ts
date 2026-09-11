/** Merchant-owned storefront tokens, using the established direct-API runtime. */
import type { CatalogEntry, CatalogConnectionField, ConnectorActionPolicy, Transport } from './types';
import { BIGCOMMERCE_ICON, SHOPLINE_ICON, SHOPLAZZA_ICON } from './catalog-storefront-brand-icons';

const labels = (zh: string, en: string, ja: string, pt: string) => ({ label_zh: zh, label_en: en, label_ja: ja, label_pt: pt });
const help = (zh: string, en: string, ja: string, pt: string) => ({ help_zh: zh, help_en: en, help_ja: ja, help_pt: pt });
const instructions = (zh: string, en: string, ja: string, pt: string) => ({ instructions_zh: zh, instructions_en: en, instructions_ja: ja, instructions_pt: pt });

const TOKEN: CatalogConnectionField = {
  key: 'access_token', input: 'secret', storage: 'credential', format: 'secret', required: true,
  ...labels('Admin API 访问令牌', 'Admin API access token', 'Admin API アクセストークン', 'Token de acesso da Admin API'),
  ...help('从上述店铺应用/API 账户复制 Access Token（不是 App Secret 或 Storefront Token）。仅在本机加密保存。',
    'Copy the Access Token from the store app/API account above, not an App Secret or Storefront Token. Stored encrypted on this device only.',
    '上記の店舗アプリ/API アカウントの Access Token をコピーしてください。App Secret や Storefront Token ではありません。この端末にのみ暗号化して保存します。',
    'Copie o Access Token do app/conta API da loja acima, não o App Secret ou Storefront Token. Salvo criptografado apenas neste dispositivo.'),
};

export function storefrontEntries(policies: Record<string, ConnectorActionPolicy>, transport: Transport): CatalogEntry[] {
  const tools = ['list_capabilities', 'describe_action', 'execute_read', 'execute_high_impact'];
  const common = {
    category: 'commerce' as const, auth_mode: 'local_api' as const,
    allowed_tools: tools, tool_policies: Object.fromEntries(tools.map((name) => [name, policies[name]])),
    transport_template: transport,
    description_zh: '使用店铺 Admin API 令牌，查询商品、订单和库存，确认后修改价格与库存。',
    description_en: 'Use a store Admin API token to read products, orders and stock, and update prices and inventory with confirmation.',
    description_ja: '店舗の Admin API トークンで商品・注文・在庫を参照し、確認後に価格と在庫を更新します。',
    description_pt: 'Use o token da Admin API da loja para consultar produtos, pedidos e estoque, e atualizar preços e estoque mediante confirmação.',
  };
  const guide = {
    requirement: 'provider_application' as const,
    guide_label_zh: '查看官方配置指引', guide_label_en: 'Open the official setup guide',
    guide_label_ja: '公式設定ガイドを開く', guide_label_pt: 'Abrir o guia oficial de configuração',
  };
  return [
    {
      ...common, id: 'bigcommerce', setup_guide_id: 'bigcommerce', display_name: 'BigCommerce', local_api: { provider: 'bigcommerce' },
      icon_svg: BIGCOMMERCE_ICON.svg, icon_source_url: BIGCOMMERCE_ICON.source_url, icon_source_sha256: BIGCOMMERCE_ICON.source_sha256,
      connection_setup: {
        ...guide, guide_url: 'https://docs.bigcommerce.com/developer/docs/overview/api-fundamentals/api-accounts#store-level-api-accounts',
        ...instructions(
          '店铺后台 Settings → Store-level API accounts，新建专用 API 账户。Products、Store Inventory 选 Modify；Orders、Information & Settings 选 Read-only，其余不授权。无需 Client Secret 或回调地址。',
          'In store Settings → Store-level API accounts, create a dedicated API account. Set Products and Store Inventory to Modify; Orders and Information & Settings to Read-only; leave other permissions disabled. No Client Secret or callback is needed.',
          '店舗の Settings → Store-level API accounts で専用 API アカウントを作成します。Products と Store Inventory は Modify、Orders・Information & Settings は Read-only、その他は無効にします。Client Secret やコールバックは不要です。',
          'Em Settings → Store-level API accounts da loja, crie uma conta API dedicada. Selecione Modify para Products e Store Inventory; Read-only para Orders e Information & Settings; mantenha as demais permissões desativadas. Não exige Client Secret nem callback.'),
        fields: [
          { key: 'store_hash', input: 'text', storage: 'metadata', format: 'bigcommerce_store_hash', required: true,
            ...labels('API Path / Store Hash', 'API Path / Store Hash', 'API Path / Store Hash', 'API Path / Store Hash'),
            ...help('复制同一 API 账户页面的完整 API Path；也可只填 /stores/ 后的 Store Hash。不是店铺网址。',
              'Copy the full API Path from the same API account page, or just the Store Hash after /stores/. Do not enter the storefront URL.',
              '同じ API アカウント画面の API Path 全体、または /stores/ の後の Store Hash をコピーしてください。店舗の公開 URL ではありません。',
              'Copie o API Path completo da mesma página, ou apenas o Store Hash após /stores/. Não use a URL pública da loja.') }, TOKEN,
        ],
      },
    },
    {
      ...common, id: 'shopline', setup_guide_id: 'shopline', display_name: 'SHOPLINE', local_api: { provider: 'shopline' },
      icon_svg: SHOPLINE_ICON.svg, icon_source_url: SHOPLINE_ICON.source_url, icon_source_sha256: SHOPLINE_ICON.source_sha256,
      connection_setup: {
        ...guide, guide_url: 'https://developer.shopline.com/docs/apps/application-management/configuring-private-applications/',
        ...instructions(
          '店铺后台 Apps → Develop Apps，创建并安装私有应用。启用 read_store_information、read_products、write_products、read_orders、read_location、read_inventory、write_inventory，再复制 Admin API Token。仅适用于 myshopline.com 店铺，无需回调。',
          'In store Apps → Develop Apps, create and install a private app. Enable read_store_information, read_products, write_products, read_orders, read_location, read_inventory and write_inventory, then copy the Admin API Token. For myshopline.com stores only; no callback required.',
          '店舗の Apps → Develop Apps でプライベートアプリを作成・インストールします。read_store_information、read_products、write_products、read_orders、read_location、read_inventory、write_inventory を有効にし、Admin API Token をコピーします。myshopline.com の店舗専用で、コールバックは不要です。',
          'Em Apps → Develop Apps da loja, crie e instale um app privado. Ative read_store_information, read_products, write_products, read_orders, read_location, read_inventory e write_inventory e copie o Admin API Token. Apenas lojas myshopline.com; sem callback.'),
        fields: [
          { key: 'store_domain', input: 'text', storage: 'metadata', format: 'shopline_store_domain', required: true,
            ...labels('原始店铺域名', 'Original store domain', '元の店舗ドメイン', 'Domínio original da loja'),
            ...help('从店铺 Settings → Domains 复制 xxx.myshopline.com，也可只填 xxx；不要填自定义域名或管理后台网址。',
              'Copy xxx.myshopline.com from store Settings → Domains, or enter just xxx. Do not use a custom domain or admin URL.',
              '店舗の Settings → Domains から xxx.myshopline.com をコピーするか、xxx のみ入力してください。独自ドメインや管理画面 URL は使用できません。',
              'Copie xxx.myshopline.com em Settings → Domains da loja, ou informe apenas xxx. Não use domínio personalizado nem URL do painel.') }, TOKEN,
        ],
      },
    },
    {
      ...common, id: 'shoplazza', setup_guide_id: 'shoplazza', display_name: 'Shoplazza', display_name_zh: '店匠', display_name_en: 'Shoplazza', local_api: { provider: 'shoplazza' },
      icon_svg: SHOPLAZZA_ICON.svg, icon_source_url: SHOPLAZZA_ICON.source_url, icon_source_sha256: SHOPLAZZA_ICON.source_sha256,
      connection_setup: {
        ...guide, guide_url: 'https://www.shoplazza.dev/docs/app/getting-started/create-private-app',
        ...instructions(
          '店铺后台 Apps → Manage Private Apps，创建私有应用。允许读取店铺、订单、仓库，并读写商品和库存；保存后复制 Access Token。无需 OAuth 应用审核或回调地址；请使用有应用管理权限的店铺账号。',
          'In store Apps → Manage Private Apps, create a private app. Allow shop, order and location reads, plus product and inventory reads/writes; save and copy the Access Token. No OAuth app review or callback is needed. Your store account must be allowed to manage apps.',
          '店舗の Apps → Manage Private Apps でプライベートアプリを作成します。店舗・注文・倉庫の読み取り、商品・在庫の読み書きを許可し、保存後に Access Token をコピーします。OAuth アプリ審査やコールバックは不要です。アプリ管理権限のある店舗アカウントを使用してください。',
          'Em Apps → Manage Private Apps da loja, crie um app privado. Permita leitura de loja, pedidos e locais, e leitura/escrita de produtos e estoque; salve e copie o Access Token. Sem aprovação de app OAuth nem callback. A conta precisa de permissão para gerenciar apps.'),
        fields: [
          { key: 'store_domain', input: 'text', storage: 'metadata', format: 'shoplazza_store_domain', required: true,
            ...labels('原始店铺域名', 'Original store domain', '元の店舗ドメイン', 'Domínio original da loja'),
            ...help('从店铺 Settings → Domains 复制 xxx.myshoplaza.com（域名中只有一个 z），也可只填 xxx；不要填自定义域名。',
              'Copy xxx.myshoplaza.com from store Settings → Domains (one z in the domain), or enter just xxx. Do not use a custom domain.',
              '店舗の Settings → Domains から xxx.myshoplaza.com（ドメイン内の z は1文字）をコピーするか、xxx のみ入力してください。独自ドメインは使用できません。',
              'Copie xxx.myshoplaza.com em Settings → Domains (um z no domínio), ou informe apenas xxx. Não use domínio personalizado.') }, TOKEN,
        ],
      },
    },
  ];
}
