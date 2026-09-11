/**
 * China collaboration connectors backed by official user-authorized CLIs.
 *
 * Artwork is copied from real maintained brand assets, never generated. `icon_source_*` records
 * the fetched source and digest so a future logo refresh must be deliberate and reviewable.
 */
import { LOCAL_CLI_MANIFESTS } from './local-cli-manifest';
import type { CatalogEntry, ConnectorActionPolicy } from './types';

const WECOM_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24"><path fill="#2F7DFF" d="m17.326 8.158-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793-.208.875.527-.267.708-.358.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81-.658.208-1.352.358-2.061.436-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704 0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39 8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977-.024-.024-.024-.018-.024-.018-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056-.035-.144a1.3 1.3 0 0 0-.358-.61 1.386 1.386 0 0 0-1.957 0 1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371.024.012.06.012.084.012q.019 0 .041.006.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0 .35.35 0 0 0 .036-.455m-1.05 4.37-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67 1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053.024.024.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076.005.03.006.057l.035.143c.06.228.18.443.358.611.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964 1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185 1.4 1.4 0 0 1-.131-.144.323.323 0 0 0-.466 0 .325.325 0 0 0-.036.455m1.039-4.358.024-.024a.32.32 0 0 1 .453.035.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67 1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095.018-.025z"/></svg>';
const LARK_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 36 29" fill="none"><path fill="#00D6B9" d="m18.43 15.043.088-.087q.086-.087.177-.174l.122-.117.36-.356.495-.481.42-.417.395-.39.412-.408.378-.373.53-.52q.15-.15.307-.291.288-.26.59-.508a13 13 0 0 1 1.414-.976q.425-.247.868-.469a12 12 0 0 1 1.345-.55q.123-.042.252-.083A20.8 20.8 0 0 0 22.648.947a1.9 1.9 0 0 0-1.48-.707H5.962a.286.286 0 0 0-.17.516 44.4 44.4 0 0 1 12.604 14.326l.035-.04z"/><path fill="#3370FF" d="M12.386 28.427c7.853 0 14.695-4.334 18.261-10.738q.189-.337.364-.681a8.4 8.4 0 0 1-.837 1.31 9 9 0 0 1-.581.677 7.5 7.5 0 0 1-.911.815 7 7 0 0 1-.412.295 8 8 0 0 1-.555.343 8 8 0 0 1-1.754.72 8 8 0 0 1-.932.2c-.226.035-.46.06-.69.078q-.365.024-.738.022a9 9 0 0 1-.824-.052 10 10 0 0 1-.612-.087 8 8 0 0 1-.533-.113c-.096-.022-.187-.048-.282-.074a57 57 0 0 1-.781-.217c-.13-.039-.26-.073-.386-.112a22 22 0 0 1-.578-.178q-.234-.073-.468-.152c-.148-.048-.3-.096-.447-.148l-.304-.104-.368-.13-.26-.095a19 19 0 0 1-.517-.191c-.1-.04-.2-.074-.3-.113l-.398-.156-.421-.17-.274-.112-.338-.14-.26-.107-.27-.118-.234-.104-.212-.095-.217-.1-.221-.104-.282-.13-.295-.14-.313-.151-.264-.13A43.9 43.9 0 0 1 .495 8.665.287.287 0 0 0 0 8.86l.009 13.42v1.089c0 .633.312 1.223.837 1.575a20.7 20.7 0 0 0 11.54 3.484z"/><path fill="#133C9A" d="M35.463 9.511a12 12 0 0 0-8.88-.672q-.124.038-.252.082a12.4 12.4 0 0 0-2.213 1.015q-.434.255-.842.547a11 11 0 0 0-1.163.937c-.104.096-.203.191-.308.29l-.529.521-.377.374-.412.407-.395.39-.421.417-.49.486-.36.356-.122.117a7 7 0 0 1-.178.174l-.087.087-.134.125-.152.14a21 21 0 0 1-4.33 3.066l.282.13.222.105.217.1.212.095.234.104.27.117.26.109.338.139.273.112.421.17q.196.078.4.156c.1.039.199.073.299.113.173.065.347.125.516.19l.26.096q.181.065.37.13l.303.104c.147.048.295.1.447.148l.468.152.577.177a52 52 0 0 0 1.167.33c.096.026.187.048.282.074q.267.063.534.113.306.053.612.086a8.3 8.3 0 0 0 2.252-.048q.469-.073.932-.199a7.6 7.6 0 0 0 1.15-.416 8 8 0 0 0 .89-.473c.095-.057.181-.117.268-.174.139-.095.278-.19.412-.295q.176-.13.339-.273a8.3 8.3 0 0 0 1.15-1.22 9.3 9.3 0 0 0 .833-1.302l.203-.402 1.814-3.614.021-.044a11.9 11.9 0 0 1 2.417-3.449"/></svg>';
const DINGTALK_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 1024 1024"><path fill="#1677FF" d="M573.7 252.5C422.5 197.4 201.3 96.7 201.3 96.7c-15.7-4.1-17.9 11.1-17.9 11.1-5 61.1 33.6 160.5 53.6 182.8 19.9 22.3 319.1 113.7 319.1 113.7S326 357.9 270.5 341.9c-55.6-16-37.9 17.8-37.9 17.8 11.4 61.7 64.9 131.8 107.2 138.4 42.2 6.6 220.1 4 220.1 4s-35.5 4.1-93.2 11.9c-42.7 5.8-97 12.5-111.1 17.8-33.1 12.5 24 62.6 24 62.6 84.7 76.8 129.7 50.5 129.7 50.5 33.3-10.7 61.4-18.5 85.2-24.2L565 743.1h84.6L603 928l205.3-271.9H700.8l22.3-38.7c.3.5.4.8.4.8S799.8 496.1 829 433.8l.6-1h-.1c5-10.8 8.6-19.7 10-25.8 17-71.3-114.5-99.4-265.8-154.5"/></svg>';

export const LOCAL_CLI_TOOLS = Object.freeze([
  'list_capabilities',
  'describe_action',
  'execute_read',
  'execute_write',
  'execute_high_impact',
  'execute_destructive',
]);

const LOCAL_CLI_POLICIES: Record<string, ConnectorActionPolicy> = Object.freeze({
  list_capabilities: { risk: 'R', confirmation: 'none', max_batch_size: 100 },
  describe_action: { risk: 'R', confirmation: 'none', max_batch_size: 1 },
  execute_read: { risk: 'R', confirmation: 'none', max_batch_size: 100 },
  execute_write: { risk: 'W', confirmation: 'preview', max_batch_size: 25 },
  execute_high_impact: {
    risk: 'H', confirmation: 'fresh', max_batch_size: 10,
    sensitive_operation: 'external_or_workflow_change',
  },
  execute_destructive: {
    risk: 'D', confirmation: 'destructive', max_batch_size: 10,
    sensitive_operation: 'destructive',
  },
});

function transportTemplate() {
  return {
    kind: 'stdio' as const,
    command: '${ORKAS_NODE}',
    args: ['${ORKAS_PC_DIR}/bin/local-cli-mcp-server.cjs'],
  };
}

function localCliConfig(provider: keyof typeof LOCAL_CLI_MANIFESTS, brand?: 'feishu' | 'lark') {
  const manifest = LOCAL_CLI_MANIFESTS[provider];
  return {
    provider: manifest.provider,
    ...(brand ? { brand } : {}),
    package_name: manifest.package_name,
    package_version: manifest.package_version,
    package_integrity: manifest.package_integrity,
    executable: manifest.executable,
    allowed_domains: [...manifest.allowed_domains],
  };
}

export const DOMESTIC_COLLABORATION_ENTRIES: CatalogEntry[] = [
  {
    id: 'wecom', setup_guide_id: 'wecom-cli',
    display_name: '企业微信',
    display_name_zh: '企业微信',
    display_name_en: 'WeCom',
    icon_svg: WECOM_ICON_SVG,
    icon_source_url: 'https://api.iconify.design/tdesign/logo-wecom.svg',
    icon_source_sha256: '8aa5f73c8b17c0229ffe431bee8dfc327ccad1333352cd99159dc7add1249f13',
    category: 'communication',
    description_zh: '通过企业微信官方 CLI 授权，读写消息、通讯录、日程、文档、表格、邮件、会议、待办和云盘。',
    description_en: 'Authorize the official WeCom CLI for messages, contacts, calendar, docs, sheets, mail, meetings, tasks, and drive.',
    description_ja: "公式 WeCom CLI を認証し、メッセージ、連絡先、カレンダー、文書、表、メール、会議、タスク、ドライブを扱います。",
    description_pt: "Autorize a CLI oficial WeCom para mensagens, contatos, calendário, documentos, planilhas, e-mail, reuniões, tarefas e arquivos.",
    auth_mode: 'local_cli',
    local_cli: localCliConfig('wecom'),
    allowed_tools: [...LOCAL_CLI_TOOLS],
    tool_policies: LOCAL_CLI_POLICIES,
    transport_template: transportTemplate(),
  },
  {
    id: 'feishu', setup_guide_id: 'lark-cli',
    display_name: '飞书',
    display_name_zh: '飞书',
    display_name_en: 'Lark',
    icon_svg: LARK_ICON_SVG,
    icon_source_url: 'https://framerusercontent.com/images/yjUmyrg0qV5d2Glkjn9sDqzacY.svg',
    icon_source_sha256: '8685f45f473cf24b93dc74b4de60ca62ff4500b098c61ceb9915a05f86c8d6f4',
    category: 'communication',
    description_zh: '通过同一个飞书/Lark 官方 CLI 用户授权；CLI 会根据扫码账号自动识别中国版或国际版并选择对应端点。',
    description_en: 'Authorize with the same official Lark/Feishu CLI; it detects the tenant edition from the scanned account and selects the matching endpoint.',
    description_ja: "共通の公式 Lark/Feishu CLI で認証します。スキャンしたアカウントからテナントのエディションを検出し、対応するエンドポイントを自動選択します。",
    description_pt: "Autorize com a mesma CLI oficial Lark/Feishu; ela detecta a edição do tenant pela conta usada na leitura do código e seleciona o endpoint correspondente.",
    auth_mode: 'local_cli',
    local_cli: localCliConfig('lark', 'feishu'),
    allowed_tools: [...LOCAL_CLI_TOOLS],
    tool_policies: LOCAL_CLI_POLICIES,
    transport_template: transportTemplate(),
  },
  {
    id: 'lark', setup_guide_id: 'lark-cli',
    display_name: 'Lark',
    display_name_zh: 'Lark',
    display_name_en: 'Lark',
    icon_svg: LARK_ICON_SVG,
    icon_source_url: 'https://framerusercontent.com/images/yjUmyrg0qV5d2Glkjn9sDqzacY.svg',
    icon_source_sha256: '8685f45f473cf24b93dc74b4de60ca62ff4500b098c61ceb9915a05f86c8d6f4',
    category: 'communication',
    description_zh: '兼容旧版本中单独创建的 Lark 国际版连接；新连接统一从“飞书”进入并自动识别。',
    description_en: 'Compatibility entry for Lark connections created by older Orkas versions; new connections use the unified Lark card with automatic detection.',
    description_ja: "旧バージョンの Orkas で作成した Lark 接続用の互換項目です。新規接続には自動検出に対応した統合 Lark カードを使用します。",
    description_pt: "Entrada de compatibilidade para conexões Lark criadas em versões antigas do Orkas; novas conexões usam o cartão Lark unificado com detecção automática.",
    auth_mode: 'local_cli',
    local_cli: localCliConfig('lark', 'lark'),
    allowed_tools: [...LOCAL_CLI_TOOLS],
    tool_policies: LOCAL_CLI_POLICIES,
    catalog_parent_id: 'feishu',
    transport_template: transportTemplate(),
  },
  {
    id: 'dingtalk', setup_guide_id: 'dingtalk-cli',
    display_name: '钉钉',
    display_name_zh: '钉钉',
    display_name_en: 'DingTalk',
    icon_svg: DINGTALK_ICON_SVG,
    icon_source_url: 'https://api.iconify.design/ant-design/dingtalk.svg',
    icon_source_sha256: '5d9022d5b091b35a818e62fafdfcdb86955f339940308f33d470d99d18956a84',
    category: 'communication',
    description_zh: '通过钉钉官方 DWS CLI 用户授权，读写消息、通讯录、日程、文档、表格、待办、审批、考勤、邮件和知识库。',
    description_en: 'Authorize the official DingTalk DWS CLI for messages, contacts, calendar, docs, sheets, tasks, approvals, attendance, mail, and wiki.',
    description_ja: "公式 DingTalk DWS CLI を認証し、メッセージ、連絡先、カレンダー、文書、表、タスク、承認、勤怠、メール、Wiki を扱います。",
    description_pt: "Autorize a CLI oficial DingTalk DWS para mensagens, contatos, calendário, documentos, planilhas, tarefas, aprovações, frequência, e-mail e wiki.",
    auth_mode: 'local_cli',
    local_cli: localCliConfig('dingtalk'),
    allowed_tools: [...LOCAL_CLI_TOOLS],
    tool_policies: LOCAL_CLI_POLICIES,
    transport_template: transportTemplate(),
  },
];
