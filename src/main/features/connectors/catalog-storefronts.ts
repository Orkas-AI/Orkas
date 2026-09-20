/** Merchant-owned storefront tokens, using the established direct-API runtime. */
import type { CatalogEntry, CatalogConnectionField, ConnectorActionPolicy, Transport } from './types';
import { BIGCOMMERCE_ICON, SHOPLINE_ICON, SHOPLAZZA_ICON } from './catalog-storefront-brand-icons';

const labels = (zh: string, en: string, ja: string, pt: string, es: string, fr: string, ko: string, de: string, ru: string, it: string) => ({ label_zh: zh, label_en: en, label_ja: ja, label_pt: pt, label_es: es, label_fr: fr, label_ko: ko, label_de: de, label_ru: ru, label_it: it });
const help = (zh: string, en: string, ja: string, pt: string, es: string, fr: string, ko: string, de: string, ru: string, it: string) => ({ help_zh: zh, help_en: en, help_ja: ja, help_pt: pt, help_es: es, help_fr: fr, help_ko: ko, help_de: de, help_ru: ru, help_it: it });
const instructions = (zh: string, en: string, ja: string, pt: string, es: string, fr: string, ko: string, de: string, ru: string, it: string) => ({ instructions_zh: zh, instructions_en: en, instructions_ja: ja, instructions_pt: pt, instructions_es: es, instructions_fr: fr, instructions_ko: ko, instructions_de: de, instructions_ru: ru, instructions_it: it });

const TOKEN: CatalogConnectionField = {
  key: 'access_token', input: 'secret', storage: 'credential', format: 'secret', required: true,
  ...labels('Admin API 访问令牌', 'Admin API access token', 'Admin API アクセストークン', 'Token de acesso da Admin API', "Token de acceso a la API de administración", "Jeton d’accès Admin API", "Admin API 액세스 토큰", "Admin API-Zugriffstoken", "Токен доступа Admin API", "Token di accesso Admin API"),
  ...help('从上述店铺应用/API 账户复制 Access Token（不是 App Secret 或 Storefront Token）。仅在本机加密保存。',
    'Copy the Access Token from the store app/API account above, not an App Secret or Storefront Token. Stored encrypted on this device only.',
    '上記の店舗アプリ/API アカウントの Access Token をコピーしてください。App Secret や Storefront Token ではありません。この端末にのみ暗号化して保存します。',
    'Copie o Access Token do app/conta API da loja acima, não o App Secret ou Storefront Token. Salvo criptografado apenas neste dispositivo.', "Copia el Access Token de la aplicación o cuenta de API de la tienda indicada arriba, no un App Secret ni un Storefront Token. Se almacena cifrado únicamente en este dispositivo.", "Copiez l’Access Token depuis l’application ou le compte API de la boutique ci-dessus, et non un App Secret ou un Storefront Token. Stocké chiffré uniquement sur cet appareil.", "위 상점 앱/API 계정에서 Access Token을 복사하세요. App Secret이나 Storefront Token이 아닙니다. 이 기기에만 암호화되어 저장됩니다.", "Kopieren Sie den Access Token aus der obigen Shop-App bzw. dem API-Konto, kein App Secret und keinen Storefront Token. Wird nur auf diesem Gerät verschlüsselt gespeichert.", "Скопируйте Access Token из указанного выше приложения магазина или API-аккаунта, а не App Secret или Storefront Token. Хранится в зашифрованном виде только на этом устройстве.", "Copia l'Access Token dall'app o dall'account API del negozio indicati sopra, non un App Secret o uno Storefront Token. Viene memorizzato in forma crittografata solo su questo dispositivo."),
};

export function storefrontEntries(policies: Record<string, ConnectorActionPolicy>, transport: Transport): CatalogEntry[] {
  const tools = ['list_capabilities', 'describe_action', 'execute_read', 'execute_high_impact'];
  const common = {
    category: 'commerce' as const, auth_mode: 'local_api' as const,
    allowed_tools: tools, tool_policies: Object.fromEntries(tools.map((name) => [name, policies[name]])),
    transport_template: transport,
    description_zh: '使用店铺 Admin API 令牌，查询商品、订单和库存，确认后修改价格与库存。',
    description_en: 'Use a store Admin API token to read products, orders and stock, and update prices and inventory with confirmation.',
    description_es: "Usa un token de la API de administración de la tienda para consultar productos, pedidos y existencias, y actualizar precios e inventario con confirmación.",
    description_fr: "Utilisez un jeton Admin API de boutique pour consulter les produits, les commandes et les stocks, et mettre à jour les prix et les stocks avec confirmation.",
    description_ko: "상점 Admin API 토큰으로 상품, 주문, 재고를 읽고 확인 후 가격과 재고를 업데이트합니다.",
    description_de: "Verwenden Sie einen Admin API-Token des Shops, um Produkte, Bestellungen und Bestände zu lesen und Preise und Bestände mit Bestätigung zu aktualisieren.",
    description_ru: "Используйте токен Admin API магазина для чтения товаров, заказов и запасов, а также обновления цен и запасов с подтверждением.",
    description_it: "Usa un token Admin API del negozio per leggere prodotti, ordini e scorte e aggiornare prezzi e inventario previa conferma.",
    description_ja: '店舗の Admin API トークンで商品・注文・在庫を参照し、確認後に価格と在庫を更新します。',
    description_pt: 'Use o token da Admin API da loja para consultar produtos, pedidos e estoque, e atualizar preços e estoque mediante confirmação.',
  };
  const guide = {
    requirement: 'provider_application' as const,
    guide_label_zh: '查看官方配置指引', guide_label_en: 'Open the official setup guide',
    guide_label_es: "Abrir la guía oficial de configuración",
    guide_label_fr: "Ouvrir le guide officiel de configuration",
    guide_label_ko: "공식 설정 가이드 열기",
    guide_label_de: "Offiziellen Einrichtungsleitfaden öffnen",
    guide_label_ru: "Открыть официальное руководство по настройке",
    guide_label_it: "Apri la guida ufficiale alla configurazione",
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
          'Em Settings → Store-level API accounts da loja, crie uma conta API dedicada. Selecione Modify para Products e Store Inventory; Read-only para Orders e Information & Settings; mantenha as demais permissões desativadas. Não exige Client Secret nem callback.', "En Settings → Store-level API accounts, crea una cuenta de API dedicada. Establece Products y Store Inventory en Modify; Orders e Information & Settings en Read-only; deja los demás permisos deshabilitados. No se necesita un Client Secret ni una URL de retorno.", "Dans Settings → Store-level API accounts de la boutique, créez un compte API dédié. Définissez Products et Store Inventory sur Modify ; Orders et Information & Settings sur Read-only ; laissez les autres autorisations désactivées. Aucun Client Secret ni rappel n’est nécessaire.", "상점의 Settings → Store-level API accounts에서 전용 API 계정을 만드세요. Products와 Store Inventory는 Modify로, Orders와 Information & Settings는 Read-only로 설정하고 나머지 권한은 비활성 상태로 두세요. Client Secret이나 콜백은 필요하지 않습니다.", "Erstellen Sie in den Shop-Einstellungen unter Settings → Store-level API accounts ein eigenes API-Konto. Setzen Sie Products und Store Inventory auf Modify, Orders und Information & Settings auf Read-only; lassen Sie andere Berechtigungen deaktiviert. Ein Client Secret oder Callback ist nicht erforderlich.", "В Settings → Store-level API accounts магазина создайте отдельный API-аккаунт. Установите Products и Store Inventory в Modify, Orders и Information & Settings — в Read-only; остальные разрешения оставьте выключенными. Client Secret и обратный вызов не нужны.", "Nelle impostazioni del negozio, vai a Settings → Store-level API accounts e crea un account API dedicato. Imposta Products e Store Inventory su Modify; Orders e Information & Settings su Read-only; lascia disabilitate le altre autorizzazioni. Non servono un Client Secret né un callback."),
        fields: [
          { key: 'store_hash', input: 'text', storage: 'metadata', format: 'bigcommerce_store_hash', required: true,
            ...labels('API Path / Store Hash', 'API Path / Store Hash', 'API Path / Store Hash', 'API Path / Store Hash', "Ruta de la API / Store Hash", "API Path / Store Hash", "API Path / Store Hash", "API Path / Store Hash", "API Path / Store Hash", "API Path / Store Hash"),
            ...help('复制同一 API 账户页面的完整 API Path；也可只填 /stores/ 后的 Store Hash。不是店铺网址。',
              'Copy the full API Path from the same API account page, or just the Store Hash after /stores/. Do not enter the storefront URL.',
              '同じ API アカウント画面の API Path 全体、または /stores/ の後の Store Hash をコピーしてください。店舗の公開 URL ではありません。',
              'Copie o API Path completo da mesma página, ou apenas o Store Hash após /stores/. Não use a URL pública da loja.', "Copia la ruta completa de la API de la misma página de la cuenta de API, o solo el Store Hash que aparece después de /stores/. No introduzcas la URL del sitio de la tienda.", "Copiez l’API Path complet depuis la même page de compte API, ou seulement le Store Hash après /stores/. Ne saisissez pas l’URL de la vitrine.", "같은 API 계정 페이지에서 전체 API Path 또는 /stores/ 뒤의 Store Hash만 복사하세요. 상점 웹사이트 URL은 입력하지 마세요.", "Kopieren Sie den vollständigen API Path von derselben API-Kontoseite oder nur den Store Hash nach /stores/. Geben Sie nicht die Shop-URL ein.", "Скопируйте полный API Path с той же страницы API-аккаунта или только Store Hash после /stores/. Не вводите URL витрины.", "Copia l'API Path completo dalla stessa pagina dell'account API oppure solo lo Store Hash dopo /stores/. Non inserire l'URL della vetrina del negozio.") }, TOKEN,
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
          'Em Apps → Develop Apps da loja, crie e instale um app privado. Ative read_store_information, read_products, write_products, read_orders, read_location, read_inventory e write_inventory e copie o Admin API Token. Apenas lojas myshopline.com; sem callback.', "En Apps → Develop Apps de la tienda, crea e instala una aplicación privada. Habilita read_store_information, read_products, write_products, read_orders, read_location, read_inventory y write_inventory y, a continuación, copia Admin API Token. Solo para tiendas myshopline.com; no se requiere una URL de retorno.", "Dans Apps → Develop Apps de la boutique, créez et installez une application privée. Activez read_store_information, read_products, write_products, read_orders, read_location, read_inventory et write_inventory, puis copiez l’Admin API Token. Pour les boutiques myshopline.com uniquement ; aucun rappel requis.", "상점의 Apps → Develop Apps에서 비공개 앱을 만들고 설치하세요. read_store_information, read_products, write_products, read_orders, read_location, read_inventory, write_inventory를 활성화한 후 Admin API Token을 복사하세요. myshopline.com 상점만 지원하며 콜백은 필요하지 않습니다.", "Erstellen und installieren Sie im Shop unter Apps → Develop Apps eine private App. Aktivieren Sie read_store_information, read_products, write_products, read_orders, read_location, read_inventory und write_inventory und kopieren Sie dann den Admin API Token. Nur für myshopline.com-Shops; kein Callback erforderlich.", "В Apps → Develop Apps магазина создайте и установите частное приложение. Включите read_store_information, read_products, write_products, read_orders, read_location, read_inventory и write_inventory, затем скопируйте Admin API Token. Только для магазинов myshopline.com; обратный вызов не нужен.", "Nel negozio, vai a Apps → Develop Apps e crea e installa un'app privata. Abilita read_store_information, read_products, write_products, read_orders, read_location, read_inventory e write_inventory, quindi copia l'Admin API Token. Solo per i negozi myshopline.com; non è richiesto un callback."),
        fields: [
          { key: 'store_domain', input: 'text', storage: 'metadata', format: 'shopline_store_domain', required: true,
            ...labels('原始店铺域名', 'Original store domain', '元の店舗ドメイン', 'Domínio original da loja', "Dominio original de la tienda", "Domaine d’origine de la boutique", "원래 상점 도메인", "Ursprüngliche Shopdomain", "Исходный домен магазина", "Dominio originale del negozio"),
            ...help('从店铺 Settings → Domains 复制 xxx.myshopline.com，也可只填 xxx；不要填自定义域名或管理后台网址。',
              'Copy xxx.myshopline.com from store Settings → Domains, or enter just xxx. Do not use a custom domain or admin URL.',
              '店舗の Settings → Domains から xxx.myshopline.com をコピーするか、xxx のみ入力してください。独自ドメインや管理画面 URL は使用できません。',
              'Copie xxx.myshopline.com em Settings → Domains da loja, ou informe apenas xxx. Não use domínio personalizado nem URL do painel.', "Copia xxx.myshopline.com desde Configuración → Dominios de la tienda, o introduce solo xxx. No uses un dominio personalizado ni una URL de administración.", "Copiez xxx.myshopline.com depuis Settings → Domains de la boutique, ou saisissez simplement xxx. N’utilisez pas de domaine personnalisé ni d’URL d’administration.", "상점의 Settings → Domains에서 xxx.myshopline.com을 복사하거나 xxx만 입력하세요. 사용자 지정 도메인이나 관리자 URL은 사용하지 마세요.", "Kopieren Sie xxx.myshopline.com aus Settings → Domains des Shops oder geben Sie nur xxx ein. Verwenden Sie keine benutzerdefinierte Domain oder Admin-URL.", "Скопируйте xxx.myshopline.com из Settings → Domains магазина или введите только xxx. Не используйте собственный домен или URL панели администратора.", "Copia xxx.myshopline.com da Settings → Domains del negozio oppure inserisci solo xxx. Non usare un dominio personalizzato o l'URL di amministrazione.") }, TOKEN,
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
          'Em Apps → Manage Private Apps da loja, crie um app privado. Permita leitura de loja, pedidos e locais, e leitura/escrita de produtos e estoque; salve e copie o Access Token. Sem aprovação de app OAuth nem callback. A conta precisa de permissão para gerenciar apps.', "En Apps → Manage Private Apps de la tienda, crea una aplicación privada. Permite la lectura de la tienda, los pedidos y las ubicaciones, además de la lectura y escritura de productos e inventario; guarda y copia el Access Token. No se necesita una revisión de la aplicación OAuth ni una URL de retorno. Tu cuenta de tienda debe tener permiso para administrar aplicaciones.", "Dans Apps → Manage Private Apps de la boutique, créez une application privée. Autorisez la lecture de la boutique, des commandes et des emplacements, ainsi que la lecture et l’écriture des produits et des stocks ; enregistrez et copiez l’Access Token. Aucun examen d’application OAuth ni rappel n’est nécessaire. Votre compte de boutique doit être autorisé à gérer les applications.", "상점의 Apps → Manage Private Apps에서 비공개 앱을 만드세요. 상점, 주문, 위치 읽기 및 상품과 재고 읽기/쓰기를 허용한 후 저장하고 Access Token을 복사하세요. OAuth 앱 심사나 콜백은 필요하지 않습니다. 상점 계정에 앱 관리 권한이 있어야 합니다.", "Erstellen Sie im Shop unter Apps → Manage Private Apps eine private App. Erlauben Sie Lesezugriffe auf Shop, Bestellungen und Standorte sowie Lese-/Schreibzugriffe auf Produkte und Bestände; speichern Sie und kopieren Sie den Access Token. Eine OAuth-App-Prüfung oder ein Callback ist nicht erforderlich. Ihr Shopkonto muss Apps verwalten dürfen.", "В Apps → Manage Private Apps магазина создайте частное приложение. Разрешите чтение магазина, заказов и местоположений, а также чтение и запись товаров и запасов; сохраните и скопируйте Access Token. Проверка OAuth-приложения и обратный вызов не нужны. Ваш аккаунт магазина должен иметь право управлять приложениями.", "Nel negozio, vai a Apps → Manage Private Apps e crea un'app privata. Consenti la lettura di negozio, ordini e sedi, oltre alla lettura e scrittura di prodotti e inventario; salva e copia l'Access Token. Non servono la revisione dell'app OAuth né un callback. Il tuo account del negozio deve essere autorizzato a gestire le app."),
        fields: [
          { key: 'store_domain', input: 'text', storage: 'metadata', format: 'shoplazza_store_domain', required: true,
            ...labels('原始店铺域名', 'Original store domain', '元の店舗ドメイン', 'Domínio original da loja', "Dominio original de la tienda", "Domaine d’origine de la boutique", "원래 상점 도메인", "Ursprüngliche Shopdomain", "Исходный домен магазина", "Dominio originale del negozio"),
            ...help('从店铺 Settings → Domains 复制 xxx.myshoplaza.com（域名中只有一个 z），也可只填 xxx；不要填自定义域名。',
              'Copy xxx.myshoplaza.com from store Settings → Domains (one z in the domain), or enter just xxx. Do not use a custom domain.',
              '店舗の Settings → Domains から xxx.myshoplaza.com（ドメイン内の z は1文字）をコピーするか、xxx のみ入力してください。独自ドメインは使用できません。',
              'Copie xxx.myshoplaza.com em Settings → Domains (um z no domínio), ou informe apenas xxx. Não use domínio personalizado.', "Copia xxx.myshoplaza.com desde Configuración → Dominios de la tienda (una sola z en el dominio), o introduce solo xxx. No uses un dominio personalizado.", "Copiez xxx.myshoplaza.com depuis Settings → Domains de la boutique (un seul z dans le domaine), ou saisissez simplement xxx. N’utilisez pas de domaine personnalisé.", "상점의 Settings → Domains에서 xxx.myshoplaza.com을 복사하거나 xxx만 입력하세요(도메인에 z는 하나입니다). 사용자 지정 도메인은 사용하지 마세요.", "Kopieren Sie xxx.myshoplaza.com aus Settings → Domains des Shops (ein z in der Domain) oder geben Sie nur xxx ein. Verwenden Sie keine benutzerdefinierte Domain.", "Скопируйте xxx.myshoplaza.com из Settings → Domains магазина (в домене одна z) или введите только xxx. Не используйте собственный домен.", "Copia xxx.myshoplaza.com da Settings → Domains del negozio (una sola z nel dominio) oppure inserisci solo xxx. Non usare un dominio personalizzato.") }, TOKEN,
        ],
      },
    },
  ];
}
