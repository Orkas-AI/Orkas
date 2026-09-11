import type { CatalogEntry, CatalogConnectionField, ConnectorActionPolicy, Transport } from './types';
import { MAGENTO_ICON, TEMU_ICON, LAZADA_ICON, SHEIN_ICON, ALIBABA_ICON } from './catalog-merchant-brand-icons';
import { LOCAL_API_REDIRECT_URI } from './oauth-redirect';
import { ALIEXPRESS_ICON } from './catalog-aliexpress-brand-icon';

const label = (zh: string, en: string, ja: string, pt: string) => ({ label_zh: zh, label_en: en, label_ja: ja, label_pt: pt });
const help = (zh: string, en: string, ja: string, pt: string) => ({ help_zh: zh, help_en: en, help_ja: ja, help_pt: pt });
const instructions = (zh: string, en: string, ja: string, pt: string) => ({ instructions_zh: zh, instructions_en: en, instructions_ja: ja, instructions_pt: pt });

export function merchantPlatformEntries(policies: Record<string, ConnectorActionPolicy>, transport: Transport): CatalogEntry[] {
  const tools = ['list_capabilities', 'describe_action', 'execute_read', 'execute_high_impact'];
  const common = { category: 'commerce' as const, auth_mode: 'local_api' as const, allowed_tools: tools,
    tool_policies: Object.fromEntries(tools.map((name) => [name, policies[name]])), transport_template: transport };
  const guide = { requirement: 'provider_application' as const, guide_label_zh: '查看官方配置指引', guide_label_en: 'Open the official setup guide', guide_label_ja: '公式設定ガイドを開く', guide_label_pt: 'Abrir o guia oficial de configuração' };
  const callback = { callback_url: LOCAL_API_REDIRECT_URI,
    callback_help_zh: '将此地址完整复制到自有应用的授权回调 / Redirect URL 配置。授权后自动返回 Orkas，无需自建回调服务。',
    callback_help_en: 'Copy this exact address to your app’s authorization callback / Redirect URL setting. Authorization returns to Orkas; no separate callback server is needed.',
    callback_help_ja: 'このアドレスを自身のアプリの認証コールバック / Redirect URL にそのまま設定します。認証後は Orkas に戻ります。別のコールバックサーバーは不要です。',
    callback_help_pt: 'Copie este endereço exato para callback de autorização / Redirect URL do seu app. A autorização retorna ao Orkas; não exige servidor de callback separado.' };
  const appFields = (appId = false): CatalogConnectionField[] => [
    { key: appId ? 'app_id' : 'app_key', input: 'text', storage: 'credential', format: 'app_key', required: true,
      ...label(appId ? 'App ID' : 'App Key', appId ? 'App ID' : 'App Key', appId ? 'App ID' : 'App Key', appId ? 'App ID' : 'App Key'),
      ...help('从下述开放平台的自有应用详情复制，不是店铺 ID。', 'Copy from your own app details in the platform described below, not the shop ID.', '下記プラットフォームの自身のアプリ詳細からコピーします。店舗 ID ではありません。', 'Copie dos detalhes do seu app na plataforma indicada abaixo, não o ID da loja.') },
    { key: 'app_secret', input: 'secret', storage: 'credential', format: 'secret', required: true,
      ...label('App Secret', 'App Secret', 'App Secret', 'App Secret'),
      ...help('从同一应用详情显示并复制；凭据和授权令牌仅在本机加密保存。', 'Reveal and copy from the same app. Credentials and authorization grants are encrypted on this device only.', '同じアプリの詳細で表示してコピーします。認証情報はこの端末にのみ暗号化して保存します。', 'Revele e copie do mesmo app. Credenciais e autorizações são criptografadas apenas neste dispositivo.') },
  ];
  const magentoKeys = ['consumer_key', 'consumer_secret', 'access_token', 'token_secret'].map((key, index): CatalogConnectionField => {
    const name = ['Consumer Key', 'Consumer Secret', 'Access Token', 'Access Token Secret'][index];
    return { key, input: 'secret', storage: 'credential', format: 'secret', required: true, ...label(name, name, name, name),
      ...help(`从同一 Integration 的授权结果复制 ${name}；仅在本机加密保存。`, `Copy ${name} from the same Integration authorization result. Stored encrypted on this device only.`, `同じ Integration の認証結果から ${name} をコピーします。この端末にのみ暗号化して保存します。`, `Copie ${name} do resultado de autorização da mesma Integration. Salvo criptografado apenas neste dispositivo.`) };
  });
  return [{
    ...common, id: 'magento', setup_guide_id: 'magento', display_name: 'Magento / Adobe Commerce', local_api: { provider: 'magento' },
    icon_svg: MAGENTO_ICON.svg, icon_source_url: MAGENTO_ICON.source_url, icon_source_sha256: MAGENTO_ICON.source_sha256,
    description_zh: '连接 Magento 2.4 / Adobe Commerce PaaS，查询商品、订单和多仓库存，确认后修改价格与库存。不适用于 Adobe Commerce SaaS。',
    description_en: 'Connect Magento 2.4 / Adobe Commerce PaaS to read products, orders and source inventory, and update price/stock with confirmation. Not Adobe Commerce SaaS.',
    description_ja: 'Magento 2.4 / Adobe Commerce PaaS の商品・注文・倉庫在庫を参照し、確認後に価格・在庫を更新します。Adobe Commerce SaaS は対象外です。',
    description_pt: 'Conecte Magento 2.4 / Adobe Commerce PaaS para consultar produtos, pedidos e estoque por origem, e alterar preço/estoque com confirmação. Não atende Adobe Commerce SaaS.',
    connection_setup: { ...guide, guide_url: 'https://experienceleague.adobe.com/en/docs/commerce-admin/systems/integrations',
      ...instructions('请店铺管理员在 System → Extensions → Integrations 新建集成。API 选 Custom，授权 All Stores、Catalog、Orders、Inventory Sources / Source Items。官方改价接口要求 Catalog 整组权限，不能只勾选 Products。Activate → Allow 后复制四项凭据；无需回调或开启独立 Bearer Token。',
        'Ask the store administrator to create an integration in System → Extensions → Integrations. Use Custom API access: All Stores, Catalog, Orders, Inventory Sources / Source Items. The official price API requires the entire Catalog permission, not Products alone. Activate → Allow and copy the four credentials. No callback or standalone Bearer Token setting needed.',
        '店舗管理者に System → Extensions → Integrations で連携を作成してもらいます。API は Custom にし、All Stores・Catalog・Orders・Inventory Sources / Source Items を許可します。公式価格 API は Products だけでなく Catalog 全体の権限が必要です。Activate → Allow 後に4つの認証情報をコピーします。コールバックや単独 Bearer Token の設定は不要です。',
        'Peça ao administrador para criar uma integração em System → Extensions → Integrations. Use Custom: All Stores, Catalog, Orders, Inventory Sources / Source Items. A API oficial de preços exige Catalog inteiro, não apenas Products. Clique Activate → Allow e copie as quatro credenciais. Não exige callback nem Bearer Token independente.'),
      fields: [{ key: 'store_url', input: 'text', storage: 'metadata', format: 'magento_store_url', required: true,
        ...label('店铺安装地址', 'Store installation URL', '店舗のインストール URL', 'URL de instalação da loja'),
        ...help('填写公开 HTTPS 安装地址，例如 https://shop.example.com/magento；不要附加 /admin 或 /rest。', 'Enter the public HTTPS installation URL, e.g. https://shop.example.com/magento; omit /admin and /rest.', '公開 HTTPS インストール URL（例：https://shop.example.com/magento）を入力します。/admin や /rest は付けません。', 'Informe a URL HTTPS pública da instalação, como https://shop.example.com/magento; sem /admin ou /rest.') }, ...magentoKeys] },
  }, {
    ...common, id: 'temu-seller', setup_guide_id: 'temu-seller', display_name: 'Temu', local_api: { provider: 'temu' },
    icon_svg: TEMU_ICON.svg, icon_source_url: TEMU_ICON.source_url, icon_source_sha256: TEMU_ICON.source_sha256,
    description_zh: '使用商家自有应用授权，查询本土/半托管店铺商品、订单和库存，确认后修改普通自有库存。',
    description_en: 'Use a merchant-owned app to read local/semi-managed shop products, orders and stock, and update ordinary self-managed stock with confirmation.',
    description_ja: '販売者自身のアプリでローカル・半委託店舗の商品・注文・在庫を参照し、確認後に通常の自己管理在庫を更新します。',
    description_pt: 'Use um app próprio para consultar produtos, pedidos e estoque de lojas locais/semigerenciadas, e atualizar estoque próprio comum mediante confirmação.',
    connection_setup: { ...guide, guide_url: 'https://partner.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303',
      ...instructions('需已有获批的 Seller in House 应用。Partner Platform → App Management 获取 App Key / App Secret；Seller Center → Apps / 授权管理授权该应用，勾选 Basic、Product、Order Management 后复制 Access Token。仅支持本土/半托管，不含全托管、预售库存或改价。令牌过期后需重新授权；无需回调。',
        'Requires an approved Seller in House app. Copy App Key / App Secret in Partner Platform → App Management. In Seller Center → Apps / authorization management, authorize the app for Basic, Product and Order Management and copy its Access Token. Local/semi-managed only; no fully managed, presale-stock or price writes. Reauthorize when the token expires; no callback required.',
        '承認済み Seller in House アプリが必要です。Partner Platform → App Management で App Key / App Secret を取得します。Seller Center → Apps / 認可管理で Basic・Product・Order Management を許可し Access Token をコピーします。ローカル・半委託専用で、全委託・予約在庫・価格変更は対象外です。期限切れ時は再認可してください。コールバックは不要です。',
        'Exige app Seller in House aprovado. Copie App Key / App Secret em Partner Platform → App Management. No Seller Center → Apps / gestão de autorizações, autorize Basic, Product e Order Management e copie o Access Token. Apenas lojas locais/semigerenciadas; sem gestão total, pré-venda ou alteração de preços. Reautorize ao expirar; não exige callback.'),
      fields: [{ key: 'region', input: 'choice', storage: 'metadata', format: 'temu_region', required: true,
        ...label('店铺所属区域', 'Shop region', '店舗の地域', 'Região da loja'),
        ...help('按店铺和应用所在的 US、EU 或 GLOBAL 平台选择，与界面语言无关。', 'Choose the US, EU or GLOBAL platform that owns the shop and app, regardless of UI language.', '店舗とアプリが属する US・EU・GLOBAL を選びます。画面言語とは無関係です。', 'Escolha US, EU ou GLOBAL conforme a loja e o app, independentemente do idioma.'),
        options: [{ value: 'us', ...label('美国', 'United States', '米国', 'Estados Unidos') }, { value: 'eu', ...label('欧洲', 'Europe', '欧州', 'Europa') }, { value: 'global', ...label('其他地区（GLOBAL）', 'Other regions (GLOBAL)', 'その他（GLOBAL）', 'Outras regiões (GLOBAL)') }] },
      ...['app_key', 'app_secret', 'access_token'].map((key): CatalogConnectionField => {
        const name = { app_key: 'App Key', app_secret: 'App Secret', access_token: 'Access Token' }[key]!;
        return { key, input: 'secret', storage: 'credential', format: key === 'app_key' ? 'app_key' : 'secret', required: true, ...label(name, name, name, name),
          ...help(key === 'access_token' ? '从 Seller Center 授权结果复制，不是后台登录 Cookie。仅在本机加密保存。' : '从上述自有应用详情复制。仅在本机加密保存。',
            key === 'access_token' ? 'Copy from the Seller Center authorization result, not a login cookie. Encrypted on this device only.' : 'Copy from your app details above. Encrypted on this device only.',
            key === 'access_token' ? 'Seller Center の認可結果からコピーします。ログイン Cookie ではありません。この端末にのみ暗号化して保存します。' : '上記の自身のアプリ詳細からコピーします。この端末にのみ暗号化して保存します。',
            key === 'access_token' ? 'Copie do resultado da autorização no Seller Center, não um cookie de login. Criptografado apenas neste dispositivo.' : 'Copie dos detalhes do seu app acima. Criptografado apenas neste dispositivo.') };
      })] },
  }, {
    ...common, id: 'lazada-seller', setup_guide_id: 'lazada-seller', display_name: 'Lazada', local_api: { provider: 'lazada' },
    icon_svg: LAZADA_ICON.svg, icon_source_url: LAZADA_ICON.source_url, icon_source_sha256: LAZADA_ICON.source_sha256,
    description_zh: '使用商家自有应用授权 Lazada 店铺，查询商品、订单和 SKU 库存，确认后修改可售库存。',
    description_en: 'Authorize a Lazada shop with a merchant-owned app to read products, orders and SKU stock, and update sellable stock with confirmation.',
    description_ja: '自身のアプリで Lazada 店舗を認証し、商品・注文・SKU 在庫を参照して、確認後に販売可能在庫を更新します。',
    description_pt: 'Autorize uma loja Lazada com app próprio para consultar produtos, pedidos e estoque de SKU, e alterar estoque vendável mediante confirmação.',
    connection_setup: { ...guide, ...callback, guide_url: 'https://open.lazada.com/apps/doc/doc?docId=108260&nodeId=10533',
      ...instructions('需要已获批的自用 ABA 应用。在 Lazada Open Platform → App Console → 应用详情获取凭据，并把目标店铺加入授权白名单。申请 Seller、Product（含库存修改）、Order 接口权限，再配置下方回调。连接时用该店铺主账号在官方页面授权；跨境多国店铺按国家分别连接。',
        'Requires an approved self-use ABA app. Get credentials in Lazada Open Platform → App Console → app details and whitelist the target seller. Enable Seller, Product (including stock updates) and Order APIs, then set the callback below. Authorize with the shop’s main account on the official page. Connect cross-border countries separately.',
        '承認済み自用 ABA アプリが必要です。Lazada Open Platform → App Console → アプリ詳細で認証情報を取得し、対象店舗を認証ホワイトリストに追加します。Seller・Product（在庫更新含む）・Order API を許可し、下記コールバックを設定します。公式ページで店舗のメインアカウントを認証してください。越境店舗は国ごとに接続します。',
        'Exige app ABA de uso próprio aprovado. Obtenha credenciais em Lazada Open Platform → App Console → detalhes do app e inclua o vendedor na lista autorizada. Habilite APIs Seller, Product (incluindo estoque) e Order e configure o callback abaixo. Autorize a conta principal da loja na página oficial. Conecte cada país separadamente.'),
      fields: [{ key: 'country', input: 'choice', storage: 'metadata', format: 'lazada_country', required: true,
        ...label('店铺所在国家', 'Shop country', '店舗の国', 'País da loja'),
        ...help('按 Seller Center 店铺选择；不同国家使用不同 API，与界面语言无关。', 'Match the Seller Center shop. Countries use different APIs, independently of UI language.', 'Seller Center の店舗の国を選びます。国ごとに API が異なり、画面言語とは無関係です。', 'Escolha conforme a loja no Seller Center. Cada país usa uma API, independentemente do idioma.'),
        options: [ ['sg', '新加坡', 'Singapore', 'シンガポール', 'Singapura'], ['my', '马来西亚', 'Malaysia', 'マレーシア', 'Malásia'], ['ph', '菲律宾', 'Philippines', 'フィリピン', 'Filipinas'], ['th', '泰国', 'Thailand', 'タイ', 'Tailândia'], ['id', '印度尼西亚', 'Indonesia', 'インドネシア', 'Indonésia'], ['vn', '越南', 'Vietnam', 'ベトナム', 'Vietnã'] ].map(([value, zh, en, ja, pt]) => ({ value, ...label(zh, en, ja, pt) })) }, ...appFields()] },
  }, {
    ...common, id: 'shein-seller', setup_guide_id: 'shein-seller', display_name: 'SHEIN', local_api: { provider: 'shein' },
    icon_svg: SHEIN_ICON.svg, icon_source_url: SHEIN_ICON.source_url, icon_source_sha256: SHEIN_ICON.source_sha256,
    description_zh: '使用商家自有应用连接 SHEIN 自运营/半托管店铺，查询商品、订单、仓库与库存，确认后更新商家虚拟库存。',
    description_en: 'Connect self-operated/semi-managed SHEIN shops with your own app to read products, orders, warehouses and stock, and update merchant virtual stock with confirmation.',
    description_ja: '自身のアプリで SHEIN 自主運営・半委託店舗の商品・注文・倉庫・在庫を参照し、確認後に販売者の仮想在庫を更新します。',
    description_pt: 'Conecte lojas SHEIN de operação própria/semigerenciadas com seu app para consultar produtos, pedidos, depósitos e estoque, e atualizar estoque virtual mediante confirmação.',
    connection_setup: { ...guide, ...callback, guide_url: 'https://open.sheincorp.com/documents/system/2169474d-1d4a-41a9-b9fd-427f63f54a63',
      ...instructions('需要已获批的自运营/半托管应用。在 SHEIN 开放平台 → 控制台 → 应用管理获取 App ID / App Secret，开通商品查询、客单查询、商家仓库和库存接口权限，并配置下方回调。用店铺主账号在官方页面授权。不支持全托管、SHEIN 自营供应链或 SHEIN 仓实物库存修改。',
        'Requires an approved self-operated/semi-managed app. Get App ID / App Secret in SHEIN Open Platform → Console → App Management. Enable product queries, customer-order queries, merchant warehouses and inventory APIs, and set the callback below. Authorize the main shop account on the official page. Fully managed/SHEIN-owned supply chains and SHEIN physical-stock writes are not supported.',
        '承認済みの自主運営・半委託アプリが必要です。SHEIN Open Platform → Console → App Management で App ID / App Secret を取得し、商品照会・注文照会・販売者倉庫・在庫 API を許可して下記コールバックを設定します。公式ページで店舗のメインアカウントを認証します。全委託・SHEIN 自営サプライチェーンや SHEIN 倉の実在庫変更は対象外です。',
        'Exige app aprovado de operação própria/semigerenciada. Obtenha App ID / App Secret em SHEIN Open Platform → Console → App Management, habilite consultas de produtos/pedidos e APIs de depósitos/estoque do lojista e configure o callback abaixo. Autorize a conta principal na página oficial. Gestão total, cadeia própria SHEIN e alterações de estoque físico SHEIN não são atendidas.'), fields: appFields(true) },
  }, {
    ...common, id: 'alibaba-com-seller', setup_guide_id: 'alibaba-com-seller', display_name: 'Alibaba.com', local_api: { provider: 'alibaba_icbu' },
    icon_svg: ALIBABA_ICON.svg, icon_source_url: ALIBABA_ICON.source_url, icon_source_sha256: ALIBABA_ICON.source_sha256,
    description_zh: '使用商家自有国际站应用查询英文商品与交易订单，确认后上下架商品；不是 1688 连接器。',
    description_en: 'Use a merchant-owned Alibaba.com app to read English products and trade orders, and list/delist products with confirmation. Not the 1688 connector.',
    description_ja: '自身の Alibaba.com アプリで英語の商品と取引注文を参照し、確認後に商品を公開・非公開にします。1688 とは別の接続です。',
    description_pt: 'Use um app próprio Alibaba.com para consultar produtos em inglês e pedidos comerciais, e publicar/retirar produtos mediante confirmação. Não é o conector 1688.',
    connection_setup: { ...guide, ...callback, guide_url: 'https://developer.alibaba.com/docs/doc.htm?articleId=118846&docType=1&treeId=456',
      ...instructions('需要已获批且绑定本店的“商家后台系统”应用。在国际站开放平台控制台 → 应用管理 → 应用证书获取 App Key / App Secret，申请国际站商品查询、上下架及 ICBU 交易订单读取权限。配置下方回调后，用商家主账号授权。自用应用到期需重新登录授权；不包含改价、改库存、退款或发货。',
        'Requires an approved Merchant Backend System app bound to your store. Get App Key / App Secret in the international Open Platform console → App Management → App Certificate. Enable product read/visibility and ICBU trade-order read APIs. Set the callback below and authorize the main merchant account. Fixed-duration self-use apps require a new login on expiry. No price, stock, refund or fulfillment writes.',
        '店舗に紐付く承認済み Merchant Backend System アプリが必要です。国際版 Open Platform → App Management → App Certificate で App Key / App Secret を取得し、商品参照・公開状態変更と ICBU 取引注文参照 API を許可します。下記コールバックを設定し、販売者メインアカウントで認証します。期限付き自用アプリは期限切れ後に再ログインが必要です。価格・在庫・返金・出荷の変更は含みません。',
        'Exige app Merchant Backend System aprovado e vinculado à loja. Obtenha App Key / App Secret no console internacional Open Platform → App Management → App Certificate. Habilite leitura/visibilidade de produtos e leitura de pedidos ICBU. Configure o callback abaixo e autorize a conta principal. Apps próprios com prazo fixo exigem novo login ao expirar. Sem alterações de preço, estoque, reembolso ou envio.'), fields: appFields() },
  }, {
    ...common, id: 'aliexpress-seller', setup_guide_id: 'aliexpress-seller', display_name: 'AliExpress', display_name_zh: '速卖通', local_api: { provider: 'aliexpress' },
    icon_svg: ALIEXPRESS_ICON.svg, icon_source_url: ALIEXPRESS_ICON.source_url, icon_source_sha256: ALIEXPRESS_ICON.source_sha256,
    description_zh: '使用商家自有应用查询店铺、商品、订单和 SKU 库存，确认后修改库存。适用于已开通 Seller Solution 接口的海外自运营卖家。',
    description_en: 'Use your own app to read shop, products, orders and SKU stock, and update stock with confirmation. For overseas self-operated sellers with Seller Solution API access.',
    description_ja: '自身のアプリで店舗・商品・注文・SKU 在庫を参照し、確認後に在庫を更新します。Seller Solution API が利用可能な海外の自主運営販売者向けです。',
    description_pt: 'Use seu app para consultar loja, produtos, pedidos e estoque de SKU, e atualizar estoque mediante confirmação. Para vendedores internacionais de operação própria com acesso às APIs Seller Solution.',
    connection_setup: { ...guide, ...callback, guide_url: 'https://developer.alibaba.com/docs/doc.htm?articleId=120687&docType=1&treeId=727',
      ...instructions('需已有获批的卖家应用。在 AliExpress Open Platform → 应用详情复制 App Key / App Secret，开通 Seller Solution 店铺、商品、订单及库存修改接口，再配置下方回调。连接后用店铺主账号授权。仅有买家、联盟或代购 API 权限不可用；不支持全托管或改价。',
        'Requires an approved seller app. Copy App Key / App Secret from AliExpress Open Platform → app details. Enable Seller Solution merchant, product, order and inventory-update APIs, then configure the callback below. Authorize the main seller account after connecting. Buyer, affiliate or dropshipping-only access is insufficient. No fully managed stores or price writes.',
        '承認済み販売者アプリが必要です。AliExpress Open Platform → アプリ詳細から App Key / App Secret をコピーします。Seller Solution の店舗・商品・注文・在庫更新 API を許可し、下記コールバックを設定します。接続後に店舗のメインアカウントで認証します。購入者・アフィリエイト・代理購入専用 API では利用できません。全委託店舗と価格変更は対象外です。',
        'Exige app de vendedor aprovado. Copie App Key / App Secret em AliExpress Open Platform → detalhes do app. Habilite APIs Seller Solution de loja, produtos, pedidos e atualização de estoque, e configure o callback abaixo. Autorize a conta principal após conectar. Acesso apenas de comprador, afiliado ou dropshipping não basta. Sem lojas totalmente gerenciadas ou alterações de preço.'), fields: appFields() },
  }];
}
