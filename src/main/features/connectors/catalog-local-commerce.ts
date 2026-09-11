/** Commerce connectors backed by official, user-authorized local CLIs. */
import { LOCAL_CLI_TOOLS } from './catalog-domestic';
import { LOCAL_CLI_MANIFESTS } from './local-cli-manifest';
import type { CatalogEntry, ConnectorActionPolicy } from './types';

// Real Xero mark from the maintained Iconify Logos collection. Source and byte digest are pinned
// on the entry below so artwork cannot silently drift into a generated approximation.
const XERO_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 256 256"><path fill="#1fc0e7" d="M128.003 256C198.693 256 256 198.689 256 128C256 57.3 198.699 0 128.003 0S0 57.3 0 128c0 70.689 57.307 128 128.003 128"/><path fill="#fff" d="m62.367 127.968l21.8-21.902a3.913 3.913 0 0 0-2.782-6.656c-1.052 0-2.036.41-2.776 1.166L56.821 122.38l-21.874-21.845a3.9 3.9 0 0 0-2.76-1.126a3.908 3.908 0 0 0-2.736 6.695l21.8 21.829l-21.788 21.845c-.763.762-1.184 1.752-1.184 2.805a3.913 3.913 0 0 0 3.909 3.914a3.87 3.87 0 0 0 2.759-1.138l21.845-21.857l21.76 21.771c.774.797 1.764 1.224 2.833 1.224a3.91 3.91 0 0 0 3.903-3.914c0-1.041-.398-2.02-1.138-2.76l-21.788-21.879zm129.599-.006a7.114 7.114 0 0 0 7.111 7.111c3.903 0 7.088-3.186 7.088-7.11c0-3.926-3.185-7.112-7.094-7.112c-3.908 0-7.088 3.186-7.088 7.111zm-13.454 0c0-11.35 9.216-20.594 20.56-20.594c11.32 0 20.553 9.245 20.553 20.594s-9.227 20.594-20.554 20.594c-11.338 0-20.56-9.233-20.56-20.594m-8.09 0c0 15.815 12.857 28.695 28.65 28.695s28.649-12.868 28.649-28.69c0-15.814-12.857-28.694-28.65-28.694c-15.798 0-28.649 12.874-28.649 28.695zm-2.03-28.2h-1.196c-3.612 0-7.094 1.138-10 3.385c-.399-1.74-1.969-3.072-3.835-3.072a3.87 3.87 0 0 0-3.868 3.891l.011 48.327c0 2.145 1.764 3.892 3.897 3.892a3.914 3.914 0 0 0 3.908-3.903v-29.719c0-9.898.91-13.903 9.375-14.961c.797-.097 1.639-.08 1.65-.08c2.31-.085 3.96-1.684 3.96-3.84a3.923 3.923 0 0 0-3.926-3.914zm-75.015 23.484c0-.114.012-.228.017-.33c2.265-8.988 10.388-15.627 20.054-15.627c9.785 0 17.977 6.792 20.138 15.94H93.372zm48.202-.74c-1.684-7.981-6.047-14.54-12.686-18.75c-9.716-6.178-22.54-5.837-31.915.853c-7.657 5.444-12.077 14.365-12.077 23.552c0 2.304.284 4.63.853 6.924c2.89 11.377 12.664 20.002 24.315 21.43c3.458.42 6.826.227 10.297-.683c3.003-.74 5.899-1.946 8.567-3.664c2.77-1.78 5.086-4.136 7.339-6.952c.034-.056.08-.096.125-.153c1.559-1.934 1.268-4.7-.438-6.008c-1.445-1.109-3.869-1.558-5.769.888c-.41.592-.87 1.195-1.365 1.792c-1.519 1.678-3.402 3.3-5.655 4.562a20.6 20.6 0 0 1-9.614 2.43c-11.366-.131-17.442-8.079-19.61-13.745a21 21 0 0 1-.87-3.3l-.057-.597h40.79c5.586-.125 8.59-4.079 7.759-8.59z"/></svg>';

const LOCAL_CLI_POLICIES: Record<string, ConnectorActionPolicy> = Object.freeze({
  list_capabilities: { risk: 'R', confirmation: 'none', max_batch_size: 100 },
  describe_action: { risk: 'R', confirmation: 'none', max_batch_size: 1 },
  execute_read: { risk: 'R', confirmation: 'none', max_batch_size: 100 },
  execute_write: { risk: 'W', confirmation: 'preview', max_batch_size: 25 },
  execute_high_impact: {
    risk: 'H', confirmation: 'fresh', max_batch_size: 10,
    sensitive_operation: 'financial_record_change',
  },
  execute_destructive: {
    risk: 'D', confirmation: 'destructive', max_batch_size: 10,
    sensitive_operation: 'destructive',
  },
});

const xero = LOCAL_CLI_MANIFESTS.xero;

export const LOCAL_COMMERCE_ENTRIES: CatalogEntry[] = [
  {
    id: 'xero', setup_guide_id: 'xero-cli',
    display_name: 'Xero',
    icon_svg: XERO_ICON_SVG,
    icon_source_url: 'https://api.iconify.design/logos/xero.svg',
    icon_source_sha256: '6850f5259ff70c8d5760c9d30f7e66ba07ad4d79b85be769e53f934fc5d5ebda',
    category: 'commerce',
    description_zh: '通过 Xero 官方 CLI 的 PKCE 用户授权，管理联系人、发票、报价、付款、银行交易、会计设置和报表。',
    description_en: 'Authorize the official Xero CLI with PKCE for contacts, invoices, quotes, payments, bank transactions, accounting settings, and reports.',
    description_ja: "PKCE 対応の公式 Xero CLI を認証し、連絡先、請求書、見積もり、支払、銀行取引、会計設定、レポートを扱います。",
    description_pt: "Autorize a CLI oficial Xero com PKCE para contatos, faturas, propostas, pagamentos, transações bancárias, configurações contábeis e relatórios.",
    auth_mode: 'local_cli',
    local_cli: {
      provider: xero.provider,
      package_name: xero.package_name,
      package_version: xero.package_version,
      package_integrity: xero.package_integrity,
      executable: xero.executable,
      allowed_domains: [...xero.allowed_domains],
    },
    allowed_tools: [...LOCAL_CLI_TOOLS],
    tool_policies: LOCAL_CLI_POLICIES,
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/local-cli-mcp-server.cjs'],
    },
  },
];
