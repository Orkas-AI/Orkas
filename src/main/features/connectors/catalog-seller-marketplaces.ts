/** Seller-owned applications; platform eligibility is not bypassed by desktop authorization. */
import type { CatalogEntry, ConnectorActionPolicy, Transport } from './types';
import { SHOPEE_ICON, TIKTOK_SHOP_ICON } from './catalog-seller-brand-icons';
import { LOCAL_API_REDIRECT_URI } from './oauth-redirect';

export function sellerMarketplaceEntries(
  policies: Record<string, ConnectorActionPolicy>, transport: Transport,
): CatalogEntry[] {
  const tools = ['list_capabilities', 'describe_action', 'execute_read', 'execute_high_impact'];
  const toolPolicies = Object.fromEntries(tools.map((name) => [name, policies[name]]));
  return [
    {
      id: 'shopee', setup_guide_id: 'shopee', display_name: 'Shopee', category: 'commerce',
      icon_svg: SHOPEE_ICON.svg, icon_source_url: SHOPEE_ICON.source_url, icon_source_sha256: SHOPEE_ICON.source_sha256,
      description_zh: '使用卖家自有 Open Platform 应用授权店铺，读取商品、订单和仓库，并确认后修改价格与库存。需要平台批准的应用和 API 权限。',
      description_en: 'Authorize a shop with your own Open Platform app to read products, orders and warehouses, and update prices and stock with confirmation. An approved app and API permissions are required.',
      description_ja: "自身の Open Platform アプリで店舗を認証し、商品、注文、倉庫を参照して、確認後に価格と在庫を更新します。アプリと API 権限の承認が必要です。",
      description_pt: "Autorize uma loja com seu próprio app Open Platform para consultar produtos, pedidos e depósitos e atualizar preços e estoque mediante confirmação. Exige app e permissões API aprovados.",
      auth_mode: 'local_api', local_api: { provider: 'shopee' },
      connection_setup: {
        callback_url: LOCAL_API_REDIRECT_URI,
        callback_help_zh: '在应用正式环境的 Redirect URL Domain 填 orkas.ai（只填域名，无需自建回调服务）。',
        callback_help_en: 'Set the production Redirect URL Domain to orkas.ai (domain only; no callback server needed).',
        callback_help_ja: "本番の Redirect URL Domain に orkas.ai を設定してください（ドメインのみ。コールバックサーバーの用意は不要です）。",
        callback_help_pt: "Defina o Redirect URL Domain de produção como orkas.ai (apenas o domínio; não é necessário servidor de callback).",
        requirement: 'provider_application',
        instructions_zh: '需要已获批的 Seller in House System 应用，以及店铺、商品、订单和价格/库存修改权限。仅连接真实店铺，请用店铺账号授权（非主账号或子账号）；个人卖家资格以所在市场为准。',
        instructions_en: 'Requires an approved Seller in House System app with Shop, Product and Order permissions, including price/stock updates. Connect a production shop using its shop account, not a main or sub-account. Individual-seller eligibility varies by market.',
        instructions_ja: "Shop、Product、Order 権限（価格・在庫更新を含む）が承認された Seller in House System アプリが必要です。本番店舗のショップアカウントで接続してください。メイン・サブアカウントは使用できません。個人販売者の申請資格は市場により異なります。",
        instructions_pt: "Exige app Seller in House System aprovado com permissões Shop, Product e Order, incluindo atualizações de preço/estoque. Conecte uma loja de produção com a conta da própria loja, não uma conta principal ou subconta. A elegibilidade de vendedores individuais varia por mercado.",
        guide_url: 'https://open.shopee.com/developer-guide/20',
        guide_label_zh: '查看 Shopee 官方应用与授权指南', guide_label_en: 'Open the official Shopee authorization guide', guide_label_ja: "Shopee 公式認証ガイドを開く", guide_label_pt: "Abrir guia oficial de autorização Shopee",
        fields: [
          { key: 'region', input: 'choice', storage: 'metadata', required: true, format: 'shopee_region', label_zh: '开放平台区域', label_en: 'Open Platform region', label_ja: "Open Platform の地域", label_pt: "Região da Open Platform",
            help_zh: '选择管理该应用的开放平台站点，不是店铺销售市场。', help_en: 'Select the Open Platform site where you manage the app, not the shop’s sales market.', help_ja: "店舗の販売市場ではなく、アプリを管理している Open Platform のサイトを選択してください。", help_pt: "Selecione o site Open Platform onde gerencia o app, não o mercado de vendas da loja.",
            options: [{ value: 'global', label_zh: '全球（open.shopee.com）', label_en: 'Global (open.shopee.com)', label_ja: "グローバル（open.shopee.com）", label_pt: "Global (open.shopee.com)" }, { value: 'cn', label_zh: '中国大陆（open.shopee.cn）', label_en: 'Mainland China (open.shopee.cn)', label_ja: "中国本土（open.shopee.cn）", label_pt: "China continental (open.shopee.cn)" }, { value: 'br', label_zh: '巴西（open.shopee.com.br）', label_en: 'Brazil (open.shopee.com.br)', label_ja: "ブラジル（open.shopee.com.br）", label_pt: "Brasil (open.shopee.com.br)" }] },
          { key: 'shop_id', input: 'text', storage: 'metadata', required: true, format: 'shopee_id', label_zh: '店铺 ID', label_en: 'Shop ID', label_ja: "ショップ ID", label_pt: "ID da loja",
            help_zh: '从店铺链接 shop/ 后或 Open Platform 店铺资料中复制数字 ID，不是用户名或 Merchant ID。', help_en: 'Copy the numeric ID after shop/ in the shop URL or from Open Platform shop details, not a username or Merchant ID.', help_ja: "ショップ URL の shop/ の後、または Open Platform の店舗詳細にある数値 ID をコピーしてください。ユーザー名や Merchant ID ではありません。", help_pt: "Copie o ID numérico após shop/ na URL da loja ou nos detalhes da loja na Open Platform; não use nome de usuário nem Merchant ID." },
          { key: 'partner_id', input: 'text', storage: 'credential', required: true, format: 'shopee_id', label_zh: 'Partner ID', label_en: 'Partner ID', label_ja: "Partner ID", label_pt: "Partner ID",
            help_zh: 'Open Platform > App List > 应用详情，复制正式环境的 Partner ID（非 Test Partner ID）。', help_en: 'Open Platform > App List > app details: copy the production Partner ID, not the Test Partner ID.', help_ja: "Open Platform > App List > アプリの詳細から本番の Partner ID をコピーしてください。Test Partner ID ではありません。", help_pt: "Em Open Platform > App List > detalhes do app, copie o Partner ID de produção, não o Test Partner ID." },
          { key: 'partner_key', input: 'secret', storage: 'credential', required: true, format: 'secret', label_zh: 'Partner Key', label_en: 'Partner Key', label_ja: "Partner Key", label_pt: "Partner Key",
            help_zh: '在同一应用详情页复制正式环境的 Partner Key（非 Test Key）。', help_en: 'Copy the production Partner Key from the same app details page, not the Test Key.', help_ja: "同じアプリの詳細画面から本番の Partner Key をコピーしてください。Test Key ではありません。", help_pt: "Copie a Partner Key de produção da mesma página de detalhes do app, não a Test Key." },
        ],
      },
      allowed_tools: tools, tool_policies: toolPolicies, transport_template: transport,
    },
    {
      id: 'tiktok-shop', setup_guide_id: 'tiktok-shop', display_name: 'TikTok Shop', category: 'commerce',
      icon_svg: TIKTOK_SHOP_ICON.svg, icon_source_url: TIKTOK_SHOP_ICON.source_url, icon_source_sha256: TIKTOK_SHOP_ICON.source_sha256,
      description_zh: '使用卖家自有 TikTok Shop 应用授权店铺，读取商品、订单和仓库，并确认后修改价格与库存；不接入 TikTok 内容账号。',
      description_en: 'Authorize your shop using a seller-owned TikTok Shop app, read products, orders and warehouses, and update prices and stock with confirmation. This is not a TikTok content-account connector.',
      description_ja: "販売者自身の TikTok Shop アプリで店舗を認証し、商品、注文、倉庫を参照して、確認後に価格と在庫を更新します。TikTok コンテンツアカウント向けの接続ではありません。",
      description_pt: "Autorize sua loja com um app próprio TikTok Shop, consulte produtos, pedidos e depósitos e atualize preços e estoque mediante confirmação. Não é um conector para contas de conteúdo TikTok.",
      auth_mode: 'local_api', local_api: { provider: 'tiktok_shop' },
      connection_setup: {
        callback_url: LOCAL_API_REDIRECT_URI,
        callback_help_zh: '将此地址完整复制到 Partner Center 中自有应用的 Redirect URL 配置；授权后自动返回 Orkas。',
        callback_help_en: 'Copy this exact address into your app’s Redirect URL setting in Partner Center. Authorization returns to Orkas automatically.',
        callback_help_ja: "このアドレスをそのまま Partner Center のアプリの Redirect URL にコピーしてください。認証後は自動的に Orkas に戻ります。",
        callback_help_pt: "Copie este endereço exato para Redirect URL do app no Partner Center. A autorização retorna ao Orkas automaticamente.",
        requirement: 'provider_application',
        instructions_zh: '需要已通过卖家开发者审核的 Custom App；入口未开放请联系平台客户经理。启用 seller.product.basic、seller.product.write、seller.order.info、seller.logistics 权限，仅可连接应用获批的店铺和市场。',
        instructions_en: 'Requires a Custom App approved for seller development; contact your account manager if access is unavailable. Enable seller.product.basic, seller.product.write, seller.order.info and seller.logistics. Only approved shops and markets can connect.',
        instructions_ja: "販売者開発用に承認された Custom App が必要です。利用できない場合は担当マネージャーにお問い合わせください。seller.product.basic、seller.product.write、seller.order.info、seller.logistics を有効にしてください。承認済みの店舗と市場のみ接続できます。",
        instructions_pt: "Exige um Custom App aprovado para desenvolvimento por vendedores; contate seu gerente de conta se não tiver acesso. Habilite seller.product.basic, seller.product.write, seller.order.info e seller.logistics. Apenas lojas e mercados aprovados podem conectar.",
        guide_url: 'https://partner.tiktokshop.com/docv2/page/seller-developer-onboarding-onepager',
        guide_label_zh: '查看 TikTok Shop 官方卖家开发者指南', guide_label_en: 'Open the official TikTok Shop seller developer guide', guide_label_ja: "TikTok Shop 公式販売者開発ガイドを開く", guide_label_pt: "Abrir guia oficial de desenvolvimento para vendedores TikTok Shop",
        fields: [
          { key: 'region', input: 'choice', storage: 'metadata', required: true, format: 'tiktok_shop_region', label_zh: '店铺授权市场', label_en: 'Shop authorization market', label_ja: "店舗の認証市場", label_pt: "Mercado de autorização da loja",
            help_zh: '美国店铺使用美国授权入口，其余市场使用全球入口；与显示语言无关。', help_en: 'US shops use the US authorization entry; other markets use the global entry, regardless of display language.', help_ja: "表示言語に関係なく、米国の店舗は米国向け認証ページ、それ以外はグローバル向けページを使用します。", help_pt: "Lojas dos EUA usam a entrada de autorização dos EUA; os demais mercados usam a global, independentemente do idioma da interface.",
            options: [{ value: 'row', label_zh: '美国以外市场', label_en: 'Outside the United States', label_ja: "米国以外", label_pt: "Fora dos Estados Unidos" }, { value: 'us', label_zh: '美国', label_en: 'United States', label_ja: "米国", label_pt: "Estados Unidos" }] },
          { key: 'shop_id', input: 'text', storage: 'metadata', required: true, format: 'tiktok_shop_code', label_zh: '店铺代码 / Shop ID', label_en: 'Shop code / Shop ID', label_ja: "ショップコード / ショップ ID", label_pt: "Código da loja / Shop ID",
            help_zh: '从 Seller Center 的店铺资料复制店铺代码，或填写已知的 API Shop ID。授权后会精确匹配该店铺；无需填写 shop_cipher。', help_en: 'Copy the shop code from your Seller Center shop profile, or enter a known API Shop ID. Orkas matches it after authorization; you do not need shop_cipher.', help_ja: "Seller Center の店舗プロフィールからショップコードをコピーするか、既知の API Shop ID を入力してください。認証後に Orkas が照合します。shop_cipher は不要です。", help_pt: "Copie o código da loja no perfil do Seller Center ou informe um Shop ID conhecido da API. Orkas faz a correspondência após a autorização; não é necessário shop_cipher." },
          { key: 'service_id', input: 'text', storage: 'credential', required: true, format: 'tiktok_service_id', label_zh: 'Service ID', label_en: 'Service ID', label_ja: "Service ID", label_pt: "Service ID",
            help_zh: '来自 Partner Center > App & Service > 应用详情，或“Copy authorization link”链接中的 service_id；不是 App Key。', help_en: 'Find it in Partner Center > App & Service > app details, or the service_id in Copy authorization link. It is not the App Key.', help_ja: "Partner Center > App & Service > アプリの詳細、または Copy authorization link 内の service_id から取得してください。App Key とは異なります。", help_pt: "Encontre em Partner Center > App & Service > detalhes do app ou em service_id no link de Copy authorization link. Não é a App Key." },
          { key: 'app_key', input: 'text', storage: 'credential', required: true, format: 'app_key', label_zh: 'App Key', label_en: 'App Key', label_ja: "App Key", label_pt: "App Key",
            help_zh: '在同一自有应用详情页复制 App Key，不要使用 TikTok for Developers 内容应用的 Client Key。', help_en: 'Copy the App Key from that seller-owned app, not a TikTok for Developers content-app Client Key.', help_ja: "販売者所有のアプリの App Key をコピーしてください。TikTok for Developers のコンテンツアプリの Client Key ではありません。", help_pt: "Copie a App Key desse app próprio de vendedor, não a Client Key de um app de conteúdo TikTok for Developers." },
          { key: 'app_secret', input: 'secret', storage: 'credential', required: true, format: 'secret', label_zh: 'App Secret', label_en: 'App Secret', label_ja: "App Secret", label_pt: "App Secret",
            help_zh: '在同一应用详情页查看并复制 App Secret。', help_en: 'Reveal and copy the App Secret from the same app details page.', help_ja: "同じアプリの詳細画面で App Secret を表示してコピーしてください。", help_pt: "Revele e copie o App Secret na mesma página de detalhes do app." },
        ],
      },
      allowed_tools: tools, tool_policies: toolPolicies, transport_template: transport,
    },
  ];
}
